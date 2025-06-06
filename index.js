const express = require("express");
const mysql = require("mysql");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const app = express();
const CryptoJS = require("crypto-js");
app.use(cors());

const multer = require("multer");
const uploadMemory = multer({ storage: multer.memoryStorage() });
const sharp = require("sharp");

require("dotenv").config();
process.env.AWS_S3_DISABLE_CHECKSUMS = "true"; // ปิด CRC32 placeholder
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_KEY,
  },
});

/* ===== AES key (ควรเก็บใน .env) ===== */
const EMP_KEY = process.env.EMP_ID_KEY || "sky45678you"; // ย้ายไป .env ภายหลังได้

function decryptEmpId(enc) {
  try {
    const encrypted =
      enc.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (enc.length % 4)) % 4);
    const bytes = CryptoJS.AES.decrypt(encrypted, EMP_KEY);
    const plain = bytes.toString(CryptoJS.enc.Utf8);
    return plain || null;
  } catch {
    return null;
  }
}

app.use(express.json());

/* ถอดรหัส emp_id แล้วเขียนทับของเก่า */
app.use((req, _res, next) => {
  if (req.query.emp_id) {
    const plain = decryptEmpId(req.query.emp_id);
    if (plain) {
      req.query.emp_id_raw = req.query.emp_id; // เก็บต้นฉบับเผื่ออยากใช้
      req.query.emp_id = plain; // เขียนทับ → โค้ดเดิมใช้ได้ทันที
    }
  }
  if (req.body && req.body.emp_id) {
    const plain = decryptEmpId(req.body.emp_id);
    if (plain) {
      req.body.emp_id_raw = req.body.emp_id;
      req.body.emp_id = plain;
    }
  }
  next();
});

const db = mysql.createConnection({
  host: "th257.ruk-com.in.th",
  user: "sharebil_sky4you",
  password: "LN5avYu2KUwGDR6Ytreg",
  port: "3306",
  database: "sharebil_sky4you",
  timezone: "+07:00", // ← เพิ่มตรงนี้
});

const companydb = mysql.createConnection({
  host: "th257.ruk-com.in.th",
  user: "sharebil_sky4you",
  password: "LN5avYu2KUwGDR6Ytreg",
  port: "3306",
  database: "sharebil_sky4you",
  timezone: "+07:00", // ← เพิ่มตรงนี้
});

// ... หลังการตั้งค่า S3Client หรือในส่วน Utilities

/**
 * ดึง S3 object key จาก URL ของ S3
 * @param {string} url URL เต็มของ S3
 * @returns {string|null} S3 object key หรือ null ถ้า URL ไม่ถูกต้อง
 */
function extractS3KeyFromUrl(url) {
  if (!url) return null;
  try {
    const urlObject = new URL(url);
    // ตัวอย่าง URL: https://my-bucket.s3.my-region.amazonaws.com/path/to/object.jpg
    // pathname จะเป็น /path/to/object.jpg เราต้องลบ / ตัวแรกออก
    if (urlObject.hostname.endsWith(".amazonaws.com")) {
      return urlObject.pathname.startsWith("/")
        ? urlObject.pathname.substring(1)
        : urlObject.pathname;
    }
    return null;
  } catch (e) {
    console.error("URL ไม่ถูกต้องสำหรับการดึง S3 key:", url, e);
    return null;
  }
}

/**
 * ลบอ็อบเจกต์ออกจาก S3
 * @param {string} s3Key S3 object key
 */
async function deleteS3Object(s3Key) {
  if (!s3Key) {
    console.log("ไม่มี S3 key สำหรับการลบ");
    return;
  }
  try {
    const command = new DeleteObjectCommand({
      Bucket: process.env.AWS_BUCKET, // <--- ตรวจสอบว่ามีตัวแปรนี้ใน .env
      Key: s3Key,
    });
    await s3.send(command);
    console.log(`ลบอ็อบเจกต์ S3 สำเร็จ: ${s3Key}`);
  } catch (error) {
    // ควร log error ไว้ แต่ไม่จำเป็นต้องทำให้ request ทั้งหมดล้มเหลว
    // เพราะเป้าหมายหลักอาจเป็นการล้างข้อมูลใน DB
    console.error(`ไม่สามารถลบอ็อบเจกต์ S3 ${s3Key}:`, error.message);
  }
}

function q(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function switchToEmployeeDB(emp_id) {
  return new Promise((resolve, reject) => {
    if (!emp_id) return resolve(); // ไม่ได้ส่ง emp_id มาก็ไม่ต้องสลับ DB

    companydb.query(
      "SELECT emp_database, emp_datapass FROM employee WHERE emp_id = ?",
      [emp_id],
      (err, rows) => {
        if (err) return reject({ status: 500, msg: "Database error", err });
        if (!rows || rows.length === 0)
          return reject({ status: 404, msg: "Employee not found" });

        const { emp_database, emp_datapass } = rows[0];
        db.changeUser(
          {
            user: emp_database,
            password: emp_datapass,
            database: emp_database,
          },
          (changeErr) => {
            if (changeErr)
              return reject({
                status: 500,
                msg: "Failed to switch database",
                err: changeErr,
              });
            resolve(); // สลับสำเร็จ
          }
        );
      }
    );
  });
}

function firstRowOr404(res, rows, notFoundMsg = "Employee not found") {
  if (!rows || rows.length === 0) {
    res.status(404).json({ error: notFoundMsg });
    return null; // caller ต้องเช็กว่าเป็น null ไหม
  }
  return rows[0];
}

// Login-------------------------------------------------------------------------------------------------------------------

app.post("/login", (req, res) => {
  /* แยกสองรูปแบบการล็อกอิน */
  const byEmpId = req.body.emp_id !== undefined && req.body.emp_id !== null;

  /* เลือก SQL และพารามิเตอร์ตามรูปแบบ */
  const sql = byEmpId
    ? "SELECT * FROM `employee` WHERE `emp_id` = ?"
    : "SELECT * FROM `employee` WHERE `username` = ? AND `password` = ?";
  const params = byEmpId
    ? [req.body.emp_id]
    : [req.body.username, req.body.password];

  /* คิวรีฐานข้อมูลกลาง */
  companydb.query(sql, params, (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      return res.status(500).json({ error: "Failed to fetch data" });
    }

    /* ---------- ป้องกันแครช ---------- */
    if (!results || results.length === 0) {
      return res
        .status(401)
        .json({ error: "Invalid credentials or employee not found" });
    }
    /* ---------------------------------- */

    const newDatabase = results[0].emp_database;
    const newUser = results[0].emp_database;
    const newPassword = results[0].emp_datapass;

    /* เปลี่ยน connection ไปยัง DB บริษัทนั้น */
    db.changeUser(
      {
        user: newUser,
        password: newPassword,
        database: newDatabase,
      },
      (changeErr) => {
        if (changeErr) {
          console.error("Error changing database:", changeErr.message);
          return res.status(500).json({ error: "Failed to switch database" });
        }
        /* ส่งกลับ results เหมือนเดิม */
        return res.json(results);
      }
    );
  });
});

app.post("/logout", (req, res) => {
  db.changeUser(
    {
      user: "sharebil_sky4you",
      password: "LN5avYu2KUwGDR6Ytreg",
      database: "sharebil_sky4you",
    },
    (changeErr) => {
      if (changeErr) {
        console.error("Error changing database:", changeErr.message);
        return res.status(500).json({ error: "Failed to switch database" });
      }
      res.json("logout finish");
    }
  );
});
// Home-------------------------------------------------------------------------------------------------------------------
app.get("/allcustomers", async (req, res) => {
  try {
    const rows = await q(
      "SELECT c.*, COUNT( CASE WHEN NOT EXISTS ( SELECT 1 FROM items AS i WHERE i.tracking_number = p.tracking_number GROUP BY i.tracking_number HAVING MIN(i.item_status) = 1 AND MAX(i.item_status) = 1 ) THEN p.tracking_number END ) AS package_count FROM customers AS c LEFT JOIN packages AS p ON c.customer_id = p.customer_id GROUP BY c.customer_id ORDER BY c.customer_date DESC;"
    );
    return res.json(rows);
  } catch (err) {
    console.error("Error fetching all customers:", err.message);
    return res.status(500).json({ error: "Failed to fetch data" });
  }
});

app.get("/customers", async (req, res) => {
  const sql = `
      SELECT c.*,
             COUNT(p.tracking_number) AS package_count
      FROM customers c
      LEFT JOIN packages p
             ON c.customer_id = p.customer_id
      WHERE NOT EXISTS (
          SELECT 1
          FROM items i
          WHERE i.tracking_number = p.tracking_number
          GROUP BY i.tracking_number
          HAVING MIN(i.item_status) = 1 AND MAX(i.item_status) = 1
      )
      GROUP BY c.customer_id
      ORDER BY c.customer_date DESC
    `;
  try {
    const rows = await q(sql);
    return res.json(rows);
  } catch (err) {
    console.error("Error fetching customers:", err.message);
    return res.status(500).json({ error: "Failed to fetch data" });
  }
});

/* ---------- helper : แปลง db.query ให้คืน Promise ---------- */
function q(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

/* --------------------------- 1. /allcustomers --------------------------- */
app.get("/allcustomers", async (req, res) => {
  try {
    const rows = await q("SELECT * FROM customers ORDER BY customer_date DESC");
    return res.json(rows);
  } catch (err) {
    console.error("Error fetching all customers:", err.message);
    return res.status(500).json({ error: "Failed to fetch data" });
  }
});

/* --------------------------- 2. /customers --------------------------- */
app.get("/customers", async (req, res) => {
  const sql = `
      SELECT c.*,
             COUNT(p.tracking_number) AS package_count
      FROM customers c
      LEFT JOIN packages p
             ON c.customer_id = p.customer_id
      WHERE NOT EXISTS (
          SELECT 1
          FROM items i
          WHERE i.tracking_number = p.tracking_number
          GROUP BY i.tracking_number
          HAVING MIN(i.item_status) = 1 AND MAX(i.item_status) = 1
      )
      GROUP BY c.customer_id
      ORDER BY c.customer_date DESC
    `;
  try {
    const rows = await q(sql);
    return res.json(rows);
  } catch (err) {
    console.error("Error fetching customers:", err.message);
    return res.status(500).json({ error: "Failed to fetch data" });
  }
});

/* --------------------- 3. /deleteCustomer (with Tx) --------------------- */
app.post("/deleteCustomer", async (req, res) => {
  // <--- ทำให้เป็น async
  const { customer_id } = req.body;
  if (!customer_id)
    return res
      .status(400)
      .json({ success: false, message: "Customer ID is required" });

  db.beginTransaction(async (txErr) => {
    // <--- ทำให้ callback ของ transaction เป็น async
    if (txErr) {
      console.error("Error starting transaction:", txErr.message);
      return res
        .status(500)
        .json({ success: false, message: "Failed to start transaction" });
    }

    try {
      // --- ส่วนลบข้อมูลจาก S3 ---
      // 1. ดึง package ทั้งหมดของลูกค้า
      const packagesToDelete = await q(
        "SELECT tracking_number, photo_url FROM packages WHERE customer_id = ?",
        [customer_id]
      );

      for (const pkg of packagesToDelete) {
        // ลบรูปของ package
        if (pkg.photo_url) {
          const packageS3Key = extractS3KeyFromUrl(pkg.photo_url);
          if (packageS3Key) await deleteS3Object(packageS3Key);
        }

        // ดึงและลบรูปของ item ใน package นี้
        const itemsInPackage = await q(
          "SELECT item_id, photo_url FROM items WHERE tracking_number = ?",
          [pkg.tracking_number]
        );
        for (const item of itemsInPackage) {
          if (item.photo_url) {
            const itemS3Key = extractS3KeyFromUrl(item.photo_url);
            if (itemS3Key) await deleteS3Object(itemS3Key);
          }
        }
      }
      // --- จบส่วนลบข้อมูลจาก S3 ---

      // คำสั่งลบข้อมูลจาก DB เดิม
      const statements = [
        // ... (คำสั่ง SQL เดิมของคุณ) ...
        `DELETE FROM subbox_item
         WHERE subbox_id IN (
           SELECT subbox_id FROM subbox
           WHERE box_id IN (SELECT box_id FROM box WHERE customer_id = ?)
         )`,
        `DELETE FROM subbox
         WHERE box_id IN (SELECT box_id FROM box WHERE customer_id = ?)`,
        `DELETE FROM slip
         WHERE box_id IN (SELECT box_id FROM box WHERE customer_id = ?)`,
        `DELETE FROM items
         WHERE tracking_number IN (
           SELECT tracking_number FROM packages WHERE customer_id = ?
         )`,
        `DELETE FROM packages WHERE customer_id = ?`,
        `DELETE FROM box WHERE customer_id = ?`,
        `DELETE FROM appointment WHERE customer_id = ?`,
        `DELETE FROM addresses   WHERE customer_id = ?`,
        `DELETE FROM customers   WHERE customer_id = ?`,
      ];

      for (const sql of statements) {
        await q(sql, [customer_id]);
      }

      db.commit((commitErr) => {
        if (commitErr) {
          console.error("Commit error:", commitErr.message);
          return db.rollback(() =>
            res
              .status(500)
              .json({ success: false, message: "Failed to commit transaction" })
          );
        }
        return res.json({
          success: true,
          message:
            "Customer and associated data (including S3 images) deleted successfully",
        });
      });
    } catch (err) {
      console.error("Tx query error during customer deletion:", err.message);
      db.rollback(() =>
        res.status(500).json({
          success: false,
          message: "Failed to delete customer and associated data",
        })
      );
    }
  });
});

// Customer-------------------------------------------------------------------------------------------------------------------
app.get("/customersDetails", async (req, res) => {
  const { id, emp_id } = req.query;

  if (!id)
    return res.status(400).json({ error: "customer_id (id) is required" });

  try {
    await switchToEmployeeDB(emp_id);
    const rows = await q("SELECT * FROM customers WHERE customer_id = ?", [id]);
    return res.json(rows); // *** คืนค่าเหมือนเดิม ***
  } catch (e) {
    console.error(e.msg || e.message);
    return res.status(e.status || 500).json({ error: e.msg || "Error" });
  }
});

app.get("/addressesinfo", async (req, res) => {
  const { id } = req.query;

  if (!id)
    return res.status(400).json({ error: "address_id (id) is required" });

  try {
    const rows = await q("SELECT * FROM addresses WHERE address_id = ?", [id]);
    return res.json(rows); // *** คืนค่าเหมือนเดิม ***
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: "Failed to fetch data" });
  }
});

app.get("/customersaddresses", async (req, res) => {
  const { id, emp_id } = req.query;

  if (!id)
    return res.status(400).json({ error: "customer_id (id) is required" });

  try {
    await switchToEmployeeDB(emp_id);
    const rows = await q("SELECT * FROM addresses WHERE customer_id = ?", [id]);
    return res.json(rows); // *** คืนค่าเหมือนเดิม ***
  } catch (e) {
    console.error(e.msg || e.message);
    return res.status(e.status || 500).json({ error: e.msg || "Error" });
  }
});

/* ------------------------- GET /customerspackages ------------------------- */
// ✔︎ GET /customerspackages (with Date_create AS received_date)
app.get("/customerspackages", async (req, res) => {
  const { id, emp_id } = req.query;

  try {
    // 1) ถ้ามี emp_id ให้สลับไปใช้ฐานข้อมูลของบริษัทนั้นก่อน
    await switchToEmployeeDB(emp_id);

    // 2) เตรียม SQL พร้อมพารามิเตอร์
    const processedId = id ?? null; // id === undefined → NULL
    const sql = `
      SELECT
        p.*,
        p.Date_create         AS received_date,
        COALESCE(SUM(CASE WHEN i.item_status = 0 THEN 1 ELSE 0 END), 0) AS sum0,
        COALESCE(SUM(CASE WHEN i.item_status = 1 THEN 1 ELSE 0 END), 0) AS sum1
      FROM packages p
      LEFT JOIN items i ON p.tracking_number = i.tracking_number
      WHERE ${
        processedId === null ? "p.customer_id IS NULL" : "p.customer_id = ?"
      }
      GROUP BY p.tracking_number;
    `;
    const params = processedId === null ? [] : [processedId];

    // 3) คิวรีแล้วส่งกลับ
    const rows = await q(sql, params);
    return res.json(rows);
  } catch (e) {
    console.error(e.msg || e.message);
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch data" });
  }
});

app.get("/nullpackages", async (_req, res) => {
  try {
    const rows = await q(
      "SELECT p.* FROM packages p WHERE p.customer_id IS NULL"
    );
    return res.json(rows); // ↩️ ส่งเหมือนเดิม
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: "Failed to fetch data" });
  }
});

app.get("/item", async (req, res) => {
  const { id, emp_id } = req.query;

  if (!id)
    return res.status(400).json({ error: "tracking_number (id) is required" });

  try {
    /* สลับฐานบริษัท (ถ้ามี emp_id) */
    await switchToEmployeeDB(emp_id);

    /* ดึงรายการ item */
    const rows = await q(
      "SELECT * FROM items WHERE tracking_number = ? AND item_status = 0",
      [id]
    );
    return res.json(rows); // ↩️ ส่งเหมือนเดิม
  } catch (e) {
    console.error(e.msg || e.message);
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch data" });
  }
});

app.post("/additems", async (req, res) => {
  const { customer_id, tracking_number, items } = req.body;

  /* validation */
  if (!customer_id || !tracking_number || !Array.isArray(items)) {
    return res.status(400).json({ error: "missing data" });
  }

  /* กรอง item ว่าง ๆ ออกไป */
  const values = items
    .filter((it) => it?.name && it?.mainCategory)
    .map((it) => [
      tracking_number,
      it.name,
      it.mainCategory,
      it.subCategory ?? "",
      it.quantity ?? 0,
      it.weight ?? 0,
      null,
      it.photo_url ?? null,
    ]);

  if (values.length === 0) {
    return res.status(400).json({ error: "no valid items to insert" });
  }

  try {
    await q(
      "INSERT INTO items (tracking_number,item_name,item_type,item_subtype,quantity,weight,packer_id,photo_url) VALUES ?",
      [values]
    );

    /* อัปเดตสถานะลูกค้าเป็น Warehouse ถ้ายังไม่มี */
    await q(
      "UPDATE customers SET status = 'Warehouse' WHERE status IS NULL AND customer_id = ?",
      [customer_id]
    );

    return res.send("Values Added and Customer Status Updated");
  } catch (err) {
    console.error("additems error:", err.message);
    return res.status(500).json({ error: "Failed to add items" });
  }
});

app.post("/edititem", async (req, res) => {
  const {
    item_id,
    item_name,
    item_type,
    item_subtype,
    quantity,
    weight,
    photo_url,
  } = req.body;

  if (!item_id || !item_name || !item_type) {
    return res.status(400).json({ error: "missing data" });
  }

  try {
    await q(
      `UPDATE items
           SET item_name   = ?,
               item_type   = ?,
               item_subtype= ?,
               quantity    = ?,
               weight      = ?,
               photo_url   = ?
         WHERE item_id = ?`,
      [item_name, item_type, item_subtype, quantity, weight, photo_url, item_id]
    );
    return res.send("Values Edited");
  } catch (err) {
    console.error("edititem error:", err.message);
    return res.status(500).json({ error: "Failed to edit item" });
  }
});

app.post("/deleteitem", async (req, res) => {
  // <--- ทำให้เป็น async
  const { customer_id, item_id } = req.body;

  if (!item_id) {
    return res.status(400).json({ error: "missing item_id" });
  }

  db.beginTransaction(async (txErr) => {
    // <--- ทำให้ callback ของ transaction เป็น async
    if (txErr) {
      console.error("Transaction start error:", txErr.message);
      return res.status(500).json({ error: "transaction error" });
    }

    try {
      // 1. ดึง photo_url ของ item ก่อนที่จะลบออกจาก DB
      const [itemToDelete] = await q(
        "SELECT photo_url FROM items WHERE item_id = ?",
        [item_id]
      );

      // 2. ลบรูปภาพจาก S3 ถ้ามี photo_url
      if (itemToDelete && itemToDelete.photo_url) {
        const s3Key = extractS3KeyFromUrl(itemToDelete.photo_url);
        if (s3Key) {
          await deleteS3Object(s3Key); // <--- ลบจาก S3
        }
      }

      // 3. ลบ item ออกจาก DB
      await q("DELETE FROM items WHERE item_id = ?", [item_id]);

      // 4. อัปเดต status ของลูกค้า (ถ้ามีการส่ง customer_id มาและเกี่ยวข้อง)
      let message = "Item Deleted";
      if (customer_id) {
        const [{ count }] = await q(
          `SELECT COUNT(*) AS count
           FROM items
           WHERE tracking_number IN (
                 SELECT tracking_number FROM packages WHERE customer_id = ?
           ) AND item_status = 0`,
          [customer_id]
        );

        if (count === 0) {
          await q(
            "UPDATE customers SET status = NULL WHERE status != 'Unpaid' AND customer_id = ?",
            [customer_id]
          );
          message = "Item Deleted and Customer Status Updated to NULL";
        }
      }

      db.commit((commitErr) => {
        if (commitErr) {
          console.error("Commit error:", commitErr.message);
          return db.rollback(() =>
            res.status(500).json({ error: "commit failed" })
          );
        }
        return res.send(message);
      });
    } catch (err) {
      console.error("deleteitem error:", err.message);
      db.rollback(() =>
        res.status(500).json({ error: "Failed to delete item" })
      );
    }
  });
});

// เเก้ไขต่อด้านล่าง

app.post("/editwarehouse", (req, res) => {
  const id = req.body.customer_id;
  const warehouse = req.body.warehouse;
  const query =
    "UPDATE `customers` SET `warehouse` = ? WHERE `customers`.`customer_id` = ?;";
  db.query(query, [warehouse, id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      res.send("Values inserted");
    }
  });
});

app.post("/createcus", (req, res) => {
  const id = req.body.customer_id;
  const contact = req.body.contact;
  const type = req.body.type;
  const level = req.body.level;
  const note = req.body.note;
  const query =
    "INSERT INTO `customers` (`customer_id`, `contact`, `type`, `level`, `note`) VALUES (?, ?, ?, ?, ?);";
  db.query(query, [id, contact, type, level, note], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      res.send("Values inserted");
    }
  });
});

app.post("/editcus", (req, res) => {
  const old_id = req.body.old_id;
  const id = req.body.customer_id;
  const contact = req.body.contact;
  const type = req.body.type;
  const level = req.body.level;
  const note = req.body.note;
  const query3 =
    "UPDATE customers SET customer_id = ?, contact = ?, type = ?, level = ?, note = ? WHERE customer_id = ?;";
  db.query(query3, [id, contact, type, level, note, old_id], (err, results) => {
    if (err) {
      console.error("Error fetching data3:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      res.send("Values Edited");
    }
  });
});

app.post("/addaddr", (req, res) => {
  const customer_id = req.body.customer_id;
  const recipient_name = req.body.recipient_name;
  const phone = req.body.phone;
  const address = req.body.address;
  const city = req.body.city;
  const state = req.body.state;
  const country = req.body.country;
  const zipcode = req.body.zipcode;
  const email = req.body.email;
  const query1 =
    "INSERT INTO `addresses` (`customer_id`, `recipient_name`, `phone`, `address`, `city`, `state`, `country`, `zipcode`, `email`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);";
  db.query(
    query1,
    [
      customer_id,
      recipient_name,
      phone,
      address,
      city,
      state,
      country,
      zipcode,
      email,
    ],
    (err, results) => {
      if (err) {
        console.error("Error fetching data:", err.message);
        res.status(500).json({ error: "Failed to fetch data" });
      } else {
        res.send("Values Edited");
      }
    }
  );
});

app.post("/editaddr", (req, res) => {
  const address_id = req.body.address_id;
  const recipient_name = req.body.recipient_name;
  const phone = req.body.phone;
  const address = req.body.address;
  const city = req.body.city;
  const state = req.body.state;
  const country = req.body.country;
  const zipcode = req.body.zipcode;
  const query1 =
    "UPDATE `addresses` SET `recipient_name` = ?, `phone` = ?, `address` = ?, `city` = ?, `state` = ?, `country` = ?, `zipcode` = ? WHERE `address_id` = ?;";
  db.query(
    query1,
    [recipient_name, phone, address, city, state, country, zipcode, address_id],
    (err, results) => {
      if (err) {
        console.error("Error fetching data:", err.message);
        res.status(500).json({ error: "Failed to fetch data" });
      } else {
        res.send("Values Edited");
      }
    }
  );
});

app.post("/deleteaddr", (req, res) => {
  const address_id = req.body.address_id;
  const query1 = "DELETE FROM addresses WHERE `addresses`.`address_id` = ?;";
  db.query(query1, [address_id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      res.send("Values Edited");
    }
  });
});

app.post("/addpackage", (req, res) => {
  const customer_id = req.body.customer_id;
  const processedcustomer_id =
    customer_id === "MISSINGITEMS" ? null : customer_id;
  const tracking_number = req.body.tracking_number;
  const photo_url = req.body.photo_url;
  if (req.body.packages_cost !== undefined) {
    const packages_cost = req.body.packages_cost;
    const query1 =
      "INSERT INTO `packages` (`tracking_number`, `customer_id`, `packages_cost`, `photo_url`) VALUES (?, ?, ?, ?);";
    db.query(
      query1,
      [tracking_number, processedcustomer_id, packages_cost, photo_url],
      (err, results) => {
        if (err) {
          console.error("Error fetching data:", err.message);
          res.status(500).json({ error: "Failed to fetch data" });
        } else {
          res.send("Values Edited");
        }
      }
    );
  } else {
    const query2 =
      "INSERT INTO `packages` (`tracking_number`, `customer_id`, `photo_url`) VALUES (?, ?, ?);";
    db.query(
      query2,
      [tracking_number, processedcustomer_id, photo_url],
      (err, results) => {
        if (err) {
          console.error("Error fetching data:", err.message);
          res.status(500).json({ error: "Failed to fetch data" });
        } else {
          res.send("Values Edited");
        }
      }
    );
  }
});

app.post("/editpackage", (req, res) => {
  const old_id = req.body.old_id;
  const customer_id = req.body.customer_id;
  const processedcustomer_id =
    customer_id === "MISSINGITEMS" || customer_id === "" ? null : customer_id;
  const tracking_number = req.body.tracking_number;
  const photo_url = req.body.photo_url;
  const query1 =
    "UPDATE `packages` SET `tracking_number` = ?, `customer_id` = ?, `photo_url` = ? WHERE `packages`.`tracking_number` = ?;";
  db.query(
    query1,
    [tracking_number, processedcustomer_id, photo_url, old_id],
    (err, results) => {
      if (err) {
        console.error("Error fetching data:", err);
        res.status(500).json({ error: "Failed to fetch data" });
      } else {
        res.send("Values Edited");
      }
    }
  );
});

app.post("/deletepackage", async (req, res) => {
  // <--- ทำให้เป็น async
  const { customer_id, tracking } = req.body;

  if (!tracking) {
    return res
      .status(400)
      .json({ error: "Tracking number (tracking) is required" });
  }

  db.beginTransaction(async (txErr) => {
    // <--- ทำให้ callback ของ transaction เป็น async
    if (txErr) {
      console.error("Transaction start error:", txErr.message);
      return res.status(500).json({ error: "Transaction error" });
    }

    try {
      // 1. ดึง photo_url ของ package
      const [packageData] = await q(
        "SELECT photo_url FROM packages WHERE tracking_number = ?",
        [tracking]
      );
      if (packageData && packageData.photo_url) {
        const packageS3Key = extractS3KeyFromUrl(packageData.photo_url);
        if (packageS3Key) {
          await deleteS3Object(packageS3Key); // <--- ลบรูป package จาก S3
        }
      }

      // 2. ดึง item ทั้งหมดที่เกี่ยวข้องกับ package นี้และ photo_url ของพวกมัน
      const itemsInPackage = await q(
        "SELECT item_id, photo_url FROM items WHERE tracking_number = ?",
        [tracking]
      );
      for (const item of itemsInPackage) {
        if (item.photo_url) {
          const itemS3Key = extractS3KeyFromUrl(item.photo_url);
          if (itemS3Key) {
            await deleteS3Object(itemS3Key); // <--- ลบรูป item จาก S3
          }
        }
      }

      // 3. ลบ items ออกจาก DB
      // Query เดิมคือ "DELETE FROM items WHERE `tracking_number` = ? AND item_status = 0;"
      // ถ้าลบ package ควรลบ item ทั้งหมดของ package นั้น ไม่ว่า status จะเป็นอะไร
      await q("DELETE FROM items WHERE tracking_number = ?", [tracking]);

      // 4. ลบ package ออกจาก DB
      await q("DELETE FROM packages WHERE tracking_number = ?", [tracking]);

      // 5. อัปเดต status ของลูกค้า (ถ้ามีการส่ง customer_id มา)
      let message = "Package and associated items deleted.";
      if (customer_id) {
        const [{ count }] = await q(
          `SELECT COUNT(*) AS count
           FROM items i
           JOIN packages p ON i.tracking_number = p.tracking_number
           WHERE p.customer_id = ? AND i.item_status = 0`,
          [customer_id]
        );

        if (count === 0) {
          await q(
            "UPDATE customers SET status = NULL WHERE customer_id = ? AND status != 'Unpaid'",
            [customer_id]
          );
          message =
            "Package and items deleted. Customer Status Updated to NULL.";
        }
      }

      db.commit((commitErr) => {
        if (commitErr) {
          console.error("Commit error:", commitErr.message);
          return db.rollback(() =>
            res.status(500).json({ error: "Failed to commit transaction" })
          );
        }
        res.send(message);
      });
    } catch (err) {
      console.error("Delete package error:", err.message);
      db.rollback(() =>
        res
          .status(500)
          .json({ error: "Failed to delete package and associated data" })
      );
    }
  });
});

// SubBox -------------------------------------------------------------------------------------------------------------------
app.get("/remainboxitem", (req, res) => {
  // ดึงค่า box_id จาก query parameter
  const { box_id } = req.query;
  // เปลี่ยนเงื่อนไขใน SQL ให้ตรงกับ box_id
  const query =
    "SELECT bi.*, bi.quantity - COALESCE(SUM(sbi.sub_quantity), 0) AS remaining_quantity, bi.weight * (bi.quantity - COALESCE(SUM(sbi.sub_quantity), 0)) / bi.quantity AS adjusted_weight FROM items bi LEFT JOIN subbox sb ON bi.box_id = sb.box_id LEFT JOIN subbox_item sbi ON sb.subbox_id = sbi.subbox_id AND bi.item_id = sbi.item_id WHERE bi.box_id = ? GROUP BY bi.item_id HAVING remaining_quantity != 0;";
  db.query(query, [box_id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      res.json(results);
    }
  });
});

app.get("/itemsubbox", (req, res) => {
  const { subbox_id } = req.query;
  const query =
    "SELECT *, i.weight * sbi.sub_quantity / i.quantity AS adjusted_weight FROM `subbox_item` sbi LEFT JOIN items i ON sbi.item_id = i.item_id WHERE `subbox_id` = ?;";
  db.query(query, [subbox_id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      res.json(results);
    }
  });
});

app.post("/edititemsubbox", (req, res) => {
  const subbox_id = req.body.subbox_id;
  const items = req.body.items;
  const query =
    "UPDATE `subbox_item` SET `sub_quantity` = ? WHERE `subbox_item`.`subbox_id` = ? AND `subbox_item`.`item_id` = ?;";
  const deleteQuery =
    "DELETE FROM `subbox_item` WHERE `subbox_item`.`subbox_id` = ? AND `subbox_item`.`item_id` = ?;";
  const promises = Object.entries(items).map(([item_id, sub_quantity]) => {
    return new Promise((resolve, reject) => {
      if (sub_quantity === 0) {
        // Perform DELETE if sub_quantity is 0
        db.query(deleteQuery, [subbox_id, item_id], (err, results) => {
          if (err) {
            console.error("Error deleting data:", err.message);
            return reject(err);
          }
          resolve({ action: "deleted", item_id });
        });
      } else {
        db.query(query, [sub_quantity, subbox_id, item_id], (err, results) => {
          if (err) {
            console.error("Error updating data:", err.message);
            return reject(err);
          }
          resolve(results);
        });
      }
    });
  });

  Promise.all(promises)
    .then((results) => {
      res.json({ message: "All items updated successfully", results });
    })
    .catch((error) => {
      console.error("Error during batch update:", error.message);
      res.status(500).json({ error: "Failed to update items" });
    });
});

app.get("/subboxinfo", (req, res) => {
  // ดึงค่า box_id จาก query parameter
  const { subbox_id } = req.query;
  // เปลี่ยนเงื่อนไขใน SQL ให้ตรงกับ box_id
  const query = "SELECT * FROM `subbox` WHERE `subbox_id` = ?;";
  db.query(query, [subbox_id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      res.json(results);
    }
  });
});

app.post("/addsubbox", (req, res) => {
  const box_id = req.body.box_id;
  const weight = req.body.weight;
  const width = req.body.width;
  const b_long = req.body.b_long;
  const height = req.body.height;
  const img_url = req.body.img_url;
  const items = req.body.items;
  const query1 =
    "INSERT INTO `subbox` (`box_id`, `weight`, `width`, `b_long`, `height`, `img_url`) VALUES (?, ?, ?, ?, ?, ?);";
  db.query(
    query1,
    [box_id, weight, width, b_long, height, img_url],
    (err, results) => {
      if (err) {
        console.error("Error fetching data:", err.message);
        res.status(500).json({ error: "Failed to fetch data" });
      } else {
        const subboxId = results.insertId;
        const values = items.map((item) => [
          subboxId,
          item.item_id,
          item.selectedQuantity === 0
            ? item.remaining_quantity
            : item.selectedQuantity,
        ]);
        if (values.length > 0) {
          const query2 =
            "INSERT INTO `subbox_item` (`subbox_id`, `item_id`, `sub_quantity`) VALUES ?;";
          db.query(query2, [values], (err, results) => {
            if (err) {
              console.error("Error in second query:", err.message);
              res.status(500).json({ error: "Failed to execute second query" });
            } else {
              res.json({ message: "Values inserted successfully", subboxId });
            }
          });
        } else {
          res.json({ message: "Values inserted successfully", subboxId });
        }
      }
    }
  );
});

app.post("/editsubbox", (req, res) => {
  const subbox_id = req.body.subbox_id;
  const weight = req.body.weight;
  const width = req.body.width;
  const b_long = req.body.b_long;
  const height = req.body.height;
  const img_url = req.body.img_url;
  const query1 =
    "UPDATE `subbox` SET `weight` = ?, `width` = ?, `b_long` = ?, `height` = ?, `img_url` = ? WHERE `subbox`.`subbox_id` = ?;";
  db.query(
    query1,
    [weight, width, b_long, height, img_url, subbox_id],
    (err, results) => {
      if (err) {
        console.error("Error fetching data:", err.message);
        res.status(500).json({ error: "Failed to fetch data" });
      } else {
        res.send("Values Edited");
      }
    }
  );
});

app.post("/editsubbox_track", (req, res) => {
  const subbox_id = req.body.subbox_id;
  const subbox_tracking = req.body.subbox_tracking;
  const subbox_cost = req.body.subbox_cost;
  const query1 =
    "UPDATE `subbox` SET `subbox_tracking` = ?, `subbox_cost` = ? WHERE `subbox_id` = ?";
  const updates = subbox_id.map((id, index) => {
    console.log([subbox_tracking[index], subbox_cost[index], id.subbox_id]);
    return new Promise((resolve, reject) => {
      db.query(
        query1,
        [subbox_tracking[index], subbox_cost[index], id.subbox_id],
        (err, results) => {
          if (err) {
            reject(err);
          } else {
            resolve(results);
          }
        }
      );
    });
  });

  Promise.all(updates)
    .then(() => {
      res.send("All values edited successfully");
    })
    .catch((err) => {
      console.error("Error updating data:", err.message);
      res.status(500).json({ error: "Failed to update data" });
    });
});

app.post("/deletesubbox", (req, res) => {
  const subbox_id = req.body.subbox_id;
  const queryDeleteSubboxItem =
    "DELETE FROM subbox_item WHERE `subbox_item`.`subbox_id` = ?;";
  const queryDeleteSubbox =
    "DELETE FROM subbox WHERE `subbox`.`subbox_id` = ?;";
  db.query(queryDeleteSubboxItem, [subbox_id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    }
    db.query(queryDeleteSubbox, [subbox_id], (err, results) => {
      if (err) {
        console.error("Error deleting subbox:", err.message);
        return res.status(500).json({ error: "Failed to delete subbox" });
      }
      // Send success response
      res.status(200).json({
        success: true,
        message: "Subbox and associated items deleted successfully",
      });
    });
  });
});

app.post("/addsubboxitem", (req, res) => {
  const items = req.body.items;
  const subbox_id = req.body.subbox_id;
  const values = items.map((item) => [
    subbox_id,
    item.item_id,
    item.quantity === 0 ? item.remaining_quantity : item.quantity,
  ]);
  const query2 =
    "INSERT INTO subbox_item (subbox_id, item_id, sub_quantity) VALUES ? ON DUPLICATE KEY UPDATE sub_quantity = sub_quantity + VALUES(sub_quantity);";
  db.query(query2, [values], (err, results) => {
    if (err) {
      console.error("Error in second query:", err.message);
      res.status(500).json({ error: "Failed to execute second query" });
    } else {
      res.send("Values Edited");
    }
  });
});

// Box -------------------------------------------------------------------------------------------------------------------
app.get("/box", (req, res) => {
  const { box_id } = req.query;
  const query = "SELECT * FROM box WHERE box_id = ?;";
  db.query(query, [box_id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      res.json(results);
    }
  });
});

app.post("/addbox", (req, res) => {
  // ดึงค่า box_id จาก query parameter
  const sender = req.body.submissionData.sender;
  const recipients = req.body.submissionData.recipients;
  const note = req.body.submissionData.note;
  const packages = req.body.submissionData.packages;
  // เปลี่ยนเงื่อนไขใน SQL ให้ตรงกับ box_id
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0"); // เดือนเริ่มจาก 0
  const day = String(now.getDate()).padStart(2, "0");
  const date = `${year}-${month}-${day}`;
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const time = `${hours}:${minutes}:${seconds}`;

  // สร้าง box_id
  const box_id = `${sender}_${date}T${time}`;
  const query =
    "INSERT INTO `box` (`box_id`, `customer_id`, `address_id`, `note`) VALUES (?, ?, ?, ?)";
  db.query(query, [box_id, sender, recipients, note], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      const boxId = box_id;
      const promises = [];
      packages.forEach((pkg) => {
        pkg.items.forEach((item) => {
          const updateQuery =
            "UPDATE `items` SET `box_id` = ?, `item_status` = ? WHERE `item_id` = ?";
          const promise = new Promise((resolve, reject) => {
            db.query(updateQuery, [boxId, 1, item.item_id], (err) => {
              if (err) {
                console.error("Error updating item:", err.message);
                reject(err);
              } else {
                resolve();
              }
            });
          });
          promises.push(promise);
        });
      });

      const updateCustomerQuery =
        "UPDATE `customers` SET `packages` = `packages` + 1 WHERE `customer_id` = ?";
      const customerUpdatePromise = new Promise((resolve, reject) => {
        db.query(updateCustomerQuery, [sender], (err) => {
          if (err) {
            console.error(
              "Error updating customer packages count:",
              err.message
            );
            reject(err);
          } else {
            resolve();
          }
        });
      });

      promises.push(customerUpdatePromise);
      // Wait for all updates to complete
      Promise.all(promises)
        .then(() => {
          res.json({ message: "Box and items added successfully", boxId });
        })
        .catch((err) => {
          console.error("Error updating items:", err.message);
          res.status(500).json({ error: "Failed to update items" });
        });
    }
  });
});

app.post("/deletebox", (req, res) => {
  // ดึงค่า box_id จาก query parameter
  const customer_id = req.body.customer_id;
  const box_id = req.body.box_id;
  // เปลี่ยนเงื่อนไขใน SQL ให้ตรงกับ box_id
  const updateItemStatusQuery = `
        UPDATE items
        SET item_status = ?, box_id = NULL
        WHERE  box_id = ?;
    `;
  db.query(updateItemStatusQuery, [0, box_id], (err) => {
    if (err) {
      res.status(500).json({ error: "Failed to update item status" });
    } else {
      // Step 2: Delete subbox_item
      const deleteSubboxItemQuery = `
                DELETE FROM subbox_item
                WHERE subbox_id IN (
                    SELECT subbox_id FROM subbox WHERE box_id = ?
                )
            `;
      db.query(deleteSubboxItemQuery, [box_id], (err) => {
        if (err) {
          res.status(500).json({ error: "Failed to delete subbox_item" });
        } else {
          // Step 3: Delete subbox
          const deleteSubboxQuery = `
                        DELETE FROM subbox WHERE box_id = ?
                    `;
          db.query(deleteSubboxQuery, [box_id], (err) => {
            if (err) {
              res.status(500).json({ error: "Failed to delete subbox" });
            } else {
              // Step 4: Delete box
              const deleteBoxQuery = `
                                DELETE FROM box WHERE box_id = ?
                            `;
              db.query(deleteBoxQuery, [box_id], (err) => {
                if (err) {
                  res
                    .status(500)
                    .json({ error: "Failed to delete box " + err });
                } else {
                  const updateCustomerQuery = `UPDATE customers SET packages = packages - 1, status = 
                                        CASE 
                                            WHEN EXISTS (
                                                SELECT 1 
                                                FROM box
                                                WHERE customer_id = ? AND box_status = 'Packed'
                                            ) THEN status
                                            WHEN EXISTS (
                                                SELECT 1 
                                                FROM items 
                                                WHERE tracking_number IN (
                                                    SELECT tracking_number 
                                                    FROM packages 
                                                    WHERE customer_id = ?
                                                ) AND item_status = 0
                                            ) THEN 'Warehouse'
                                            ELSE NULL
                                        END WHERE customer_id = ?`;
                  db.query(
                    updateCustomerQuery,
                    [customer_id, customer_id, customer_id],
                    (err) => {
                      if (err) {
                        res
                          .status(500)
                          .json({ error: "Failed to delete box2 " + err });
                      } else {
                        res.json({
                          message: "Box delete successfully",
                          box_id,
                        });
                      }
                    }
                  );
                }
              });
            }
          });
        }
      });
    }
  });
});

app.get("/boxitem", (req, res) => {
  // ดึงค่า box_id จาก query parameter
  const { box_id } = req.query;
  // เปลี่ยนเงื่อนไขใน SQL ให้ตรงกับ box_id
  const query = "SELECT * FROM items WHERE box_id = ?;";
  db.query(query, [box_id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      res.json(results);
    }
  });
});

app.get("/boxslip", (req, res) => {
  // ดึงค่า box_id จาก query parameter
  const { box_id } = req.query;
  // เปลี่ยนเงื่อนไขใน SQL ให้ตรงกับ box_id
  const query = "SELECT * FROM slip WHERE box_id = ?;";
  db.query(query, [box_id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      res.json(results);
    }
  });
});

app.get("/subbox", (req, res) => {
  // ดึงค่า box_id จาก query parameter
  const { box_id } = req.query;
  // เปลี่ยนเงื่อนไขใน SQL ให้ตรงกับ box_id
  // 1. ดึงข้อมูลจากตาราง subbox ที่มี box_id ตามที่กำหนด
  const querySubbox =
    "SELECT subbox.*, ROUND(GREATEST(subbox.weight, (subbox.width * subbox.b_long * subbox.height) / 5000), 2) AS volumetricWeight FROM subbox WHERE box_id = ?;";
  db.query(querySubbox, [box_id], (err, subboxes) => {
    if (err) {
      console.error("Error fetching subboxes:", err.message);
      return res.status(500).json({ error: "Failed to fetch subboxes" });
    }

    // กรณีไม่มี subbox ใดเลย ให้ส่งกลับ array ว่าง
    if (subboxes.length === 0) {
      return res.json([]);
    }

    // 2. เอา subbox_id ทั้งหมดที่ได้ไปดึงข้อมูลจาก subbox_item
    const subboxIds = subboxes.map((sub) => sub.subbox_id);
    // เช่น [1, 2, 3, ...]

    // ใช้ IN(?) เพื่อดึงข้อมูล subbox_item ทั้งหมดที่ subbox_id อยู่ใน list
    const querySubboxItem =
      "SELECT *, i.weight * sbi.sub_quantity / i.quantity AS adjusted_weight FROM subbox_item sbi LEFT JOIN items AS i ON sbi.item_id = i.item_id WHERE subbox_id IN (?);";
    db.query(querySubboxItem, [subboxIds], (err, subboxItems) => {
      if (err) {
        console.error("Error fetching subbox_items:", err.message);
        return res.status(500).json({ error: "Failed to fetch subbox_items" });
      }

      // 3. รวมข้อมูล subbox กับ subbox_item ให้เป็นโครงสร้างซ้อนกัน
      // เช่น [{ subbox_id: 1, box_id: 10, ..., items: [ {...}, {...} ] }, ...]
      const subboxMap = {};
      // เตรียม map เพื่อเก็บ subbox แต่ละตัว โดย key คือ subbox_id

      subboxes.forEach((sb) => {
        subboxMap[sb.subbox_id] = {
          ...sb,
          items: [], // เตรียม array ว่าง ๆ สำหรับ subbox_item
        };
      });

      subboxItems.forEach((item) => {
        // หาว่า item นี้อยู่ใน subbox ไหน
        if (subboxMap[item.subbox_id]) {
          subboxMap[item.subbox_id].items.push(item);
        }
      });

      // แปลง Object map -> Array เพื่อส่งกลับเป็น JSON
      const result = Object.values(subboxMap);
      res.json(result);
    });
  });
});

app.get("/subbox_box", (req, res) => {
  // ดึงค่า box_id จาก query parameter
  const { box_id } = req.query;
  // เปลี่ยนเงื่อนไขใน SQL ให้ตรงกับ box_id
  // 1. ดึงข้อมูลจากตาราง subbox ที่มี box_id ตามที่กำหนด
  const querySubbox = "SELECT * FROM subbox WHERE box_id = ?;";
  db.query(querySubbox, [box_id], (err, subboxes) => {
    if (err) {
      console.error("Error fetching subboxes:", err.message);
      return res.status(500).json({ error: "Failed to fetch subboxes" });
    } else {
      res.json(subboxes);
    }
  });
});

app.post("/createslip", (req, res) => {
  const slip = req.body.slip;
  const amount = req.body.amount;
  const details = req.body.details;
  const bid = req.body.BoxId;
  const query =
    "INSERT INTO `slip` (`box_id`, `slip_img`, `price`, `details`) VALUES (?, ?, ?, ?);";
  db.query(query, [bid, slip, amount, details], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      res.send("Values inserted");
    }
  });
});

app.post("/deleteslip", (req, res) => {
  const slip = req.body.slip;
  const query = "DELETE FROM slip WHERE `slip`.`slip_id` = ?;";
  db.query(query, [slip], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      res.send("Values inserted");
    }
  });
});

// packages & completed-------------------------------------------------------------------------------------------------------------------
app.get("/box1", (req, res) => {
  const query =
    "SELECT * FROM box WHERE box_status = 'Ordered' ORDER BY `priority` ASC;;";
  db.query(query, (err, OrderedResults) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    }

    const query2 =
      "SELECT * FROM box WHERE box_status = 'Process' ORDER BY `priority` ASC;;";
    db.query(query2, (err, ProcessResults) => {
      if (err) {
        console.error("Error in second query:", err.message);
        return res
          .status(500)
          .json({ error: "Failed to fetch data from second query" });
      }

      // Third Query
      const query3 =
        "SELECT * FROM box WHERE box_status = 'Packed' ORDER BY `priority` ASC;;";
      db.query(query3, (err, PackedResults) => {
        if (err) {
          console.error("Error in third query:", err.message);
          return res
            .status(500)
            .json({ error: "Failed to fetch data from third query" });
        }
        res.json({
          Ordered: OrderedResults,
          Process: ProcessResults,
          Packed: PackedResults,
        });
      });
    });
  });
});

app.get("/box2", (req, res) => {
  const query =
    "SELECT * FROM box WHERE box_status = 'Paid' ORDER BY `priority` ASC;;";
  db.query(query, (err, PaidResults) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    }

    const query2 =
      "SELECT * FROM box WHERE box_status = 'Documented' ORDER BY `priority` ASC;;";
    db.query(query2, (err, DocumentedResults) => {
      if (err) {
        console.error("Error in second query:", err.message);
        return res
          .status(500)
          .json({ error: "Failed to fetch data from second query" });
      }
      res.json({
        Paid: PaidResults,
        Documented: DocumentedResults,
      });
    });
  });
});

app.post("/editbox", (req, res) => {
  const box_id = req.body.box_id;
  const box_status = req.body.box_status;
  if (req.body.bprice !== undefined) {
    const bprice = req.body.bprice;
    const customer_id = req.body.customer_id;
    const document = req.body.document;
    const query1 =
      "UPDATE `box` SET `box_status` = ?, `bprice` = ?, `document` = ? WHERE `box_id` = ?;";
    db.query(query1, [box_status, bprice, document, box_id], (err, results) => {
      if (err) {
        console.error("Error fetching data:", err.message);
        res.status(500).json({ error: "Failed to fetch data" });
      }
      if (box_status === "Packed") {
        const query2 = `
                UPDATE customers 
                SET status = 'Unpaid' 
                WHERE customer_id =?;`;
        db.query(query2, [customer_id], (err, results) => {
          if (err) {
            console.error("Error updating customer status:", err.message);
            res.status(500).json({ error: "Failed to update customer status" });
          } else {
            res.send("Values Added and Customer Status Updated");
          }
        });
      } else {
        const query2 = `
                UPDATE customers 
                SET status = 
                    CASE 
                        WHEN EXISTS (
                            SELECT 1 
                            FROM items 
                            WHERE tracking_number IN (
                                SELECT tracking_number 
                                FROM packages 
                                WHERE customer_id = ?
                            ) AND item_status = 0
                        ) THEN 'Warehouse'
                        ELSE NULL
                    END
                WHERE customer_id =?;`;
        db.query(query2, [customer_id, customer_id], (err, results) => {
          if (err) {
            console.error("Error updating customer status:", err.message);
            res.status(500).json({ error: "Failed to update customer status" });
          } else {
            res.send("Values Added and Customer Status Updated");
          }
        });
      }
    });
  } else if (req.body.discount !== undefined) {
    const discount = req.body.discount;
    const query1 = "UPDATE `box` SET `discount` = ? WHERE `box_id` = ?;";
    db.query(query1, [discount, box_id], (err, results) => {
      if (err) {
        console.error("Error fetching data:", err.message);
        res.status(500).json({ error: "Failed to fetch data" });
      } else {
        res.send("Values Edited");
      }
    });
  } else if (req.body.customer_id !== undefined) {
    const customer_id = req.body.customer_id;
    const query1 = "UPDATE `box` SET `box_status` = ? WHERE `box_id` = ?;";
    db.query(query1, [box_status, box_id], (err, results) => {
      if (err) {
        console.error("Error fetching data:", err.message);
        res.status(500).json({ error: "Failed to fetch data" });
      } else {
        if (box_status === "Paid") {
          const query2 = `
                    UPDATE customers 
                    SET status = 
                        CASE 
                            WHEN EXISTS (
                                SELECT 1 
                                FROM items 
                                WHERE tracking_number IN (
                                    SELECT tracking_number 
                                    FROM packages 
                                    WHERE customer_id = ?
                                ) AND item_status = 0
                            ) THEN 'Warehouse'
                            ELSE NULL
                        END
                    WHERE customer_id =?;`;
          db.query(query2, [customer_id, customer_id], (err, results) => {
            if (err) {
              console.error("Error updating customer status:", err.message);
              res
                .status(500)
                .json({ error: "Failed to update customer status" });
            } else {
              res.send("Values Added and Customer Status Updated");
            }
          });
        } else {
          const query2 = `
                    UPDATE customers 
                    SET status = 'Unpaid' 
                    WHERE customer_id =?;`;
          db.query(query2, [customer_id], (err, results) => {
            if (err) {
              console.error("Error updating customer status:", err.message);
              res
                .status(500)
                .json({ error: "Failed to update customer status" });
            } else {
              res.send("Values Added and Customer Status Updated");
            }
          });
        }
      }
    });
  } else {
    const query1 = "UPDATE `box` SET `box_status` = ? WHERE `box_id` = ?;";
    db.query(query1, [box_status, box_id], (err, results) => {
      if (err) {
        console.error("Error fetching data:", err.message);
        res.status(500).json({ error: "Failed to fetch data" });
      } else {
        res.send("Values Edited");
      }
    });
  }
});

app.post("/editpriority", (req, res) => {
  const box_id = req.body.box_id;
  const priority = req.body.priority;
  const query1 = "UPDATE `box` SET `priority` = ? WHERE `box_id` = ?;";
  db.query(query1, [priority, box_id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      res.send("Values Edited");
    }
  });
});

// appointment-------------------------------------------------------------------------------------------------------------------

app.get("/appointment", (req, res) => {
  const query =
    "SELECT *, DATE_FORMAT(start_date, '%Y-%m-%d') AS formatted_start_date FROM appointment WHERE status = 'Pending' AND start_date > CURDATE() - INTERVAL 1 DAY;";
  db.query(query, (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      res.json(results);
    }
  });
});

app.post("/addappoint", async (req, res) => {
  const title = req.body.title;
  const address_pickup = req.body.address_pickup;
  const phone_pickup = req.body.phone_pickup;
  const name_pickup = req.body.name_pickup;
  const position = req.body.position;
  const vehicle = req.body.vehicle;
  const note = req.body.note;
  const emp_id = req.body.emp_id;
  const pickupdate = req.body.pickupdate;
  const pickupTime = req.body.pickupTime;
  const dateTime = new Date(`${pickupdate}T${pickupTime}:00.000Z`);
  const start_time = dateTime
    .toISOString()
    .replace("T", " ")
    .replace(".000Z", "");
  dateTime.setMinutes(dateTime.getMinutes() + 30);
  const end_time = dateTime
    .toISOString()
    .replace("T", " ")
    .replace(".000Z", "");
  try {
    await switchToEmployeeDB(emp_id);
    const rows = await q("INSERT INTO `appointment` (`title`, `start_date`, `end_date`, `note`, `customer_id`, `address_pickup`, `phone_pickup`, `name_pickup`, `position`, `vehicle`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);", [
      title,
      start_time,
      end_time,
      note,
      title,
      address_pickup,
      phone_pickup,
      name_pickup,
      position,
      vehicle,
    ]);
    return res.json(rows); // *** คืนค่าเหมือนเดิม ***
  } catch (e) {
    console.error(e.msg || e.message);
    return res.status(e.status || 500).json({ error: e.msg || "Error" });
  }
});

app.post("/editappoint", (req, res) => {
  if (req.body.status !== undefined) {
    const status = req.body.status;
    const address_id = req.body.address_id;
    const query1 =
      "UPDATE `appointment` SET `status` = ? WHERE `appointment`.`appoint_id` = ?;";
    db.query(
      query1,
      [
        status,
        address_id,
      ],
      (err, results) => {
        if (err) {
          console.error("Error fetching data:", err.message);
          res.status(500).json({ error: "Failed to fetch data" });
        } else {
          res.send("Values Edited");
        }
      }
    );
  }
  else {
    const address_id = req.body.address_id;
    const address_pickup = req.body.address_pickup;
    const phone_pickup = req.body.phone_pickup;
    const name_pickup = req.body.name_pickup;
    const position = req.body.position;
    const vehicle = req.body.vehicle;
    const note = req.body.note;
    const query1 =
      "UPDATE `appointment` SET `note` = ?, `address_pickup` = ?, `phone_pickup` = ?, `name_pickup` = ?, `position` = ?, `vehicle` = ? WHERE `appointment`.`appoint_id` = ?;";
    db.query(
      query1,
      [
        note,
        address_pickup,
        phone_pickup,
        name_pickup,
        position,
        vehicle,
        address_id,
      ],
      (err, results) => {
        if (err) {
          console.error("Error fetching data:", err.message);
          res.status(500).json({ error: "Failed to fetch data" });
        } else {
          res.send("Values Edited");
        }
      }
    );
  }
});

// ThaiBox-------------------------------------------------------------------------------------------------------------------
app.get("/gentrack", (req, res) => {
  const { type } = req.query;
  const typelike = type + "%";
  const query =
    "SELECT tracking_number FROM `packages` WHERE `tracking_number` LIKE ? ORDER BY CAST(SUBSTRING(tracking_number, INSTR(tracking_number, '-') + 1) AS UNSIGNED) DESC LIMIT 1;";
  db.query(query, [typelike], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      res.json(results);
    }
  });
});

// User-------------------------------------------------------------------------------------------------------------------
// app.post("/editsendaddr", (req, res) => {
//   const customer_id = req.body.customer_id;
//   const customer_name = req.body.customer_name;
//   const address = req.body.address;
//   const city = req.body.city;
//   const state = req.body.state;
//   const country = req.body.country;
//   const zipcode = req.body.zipcode;
//   const phone = req.body.phone;
//   const doc_type = req.body.doc_type;
//   const doc_url = req.body.doc_url;
//   if (req.body.emp_id !== undefined) {
//     const emp_id = req.body.emp_id;
//     const querydb = "SELECT * FROM employee WHERE emp_id = ?";
//     companydb.query(querydb, [emp_id], (err, results) => {
//       if (err) {
//         console.error("Error fetching data:", err.message);
//         res.status(500).json({ error: "Failed to fetch data" });
//       } else {
//         const newDatabase = results[0].emp_database; // Example of dynamic DB
//         const newUser = results[0].emp_database; // Example of dynamic user
//         const newPassword = results[0].emp_datapass; // Example of dynamic password
//         db.changeUser(
//           {
//             user: newUser,
//             password: newPassword,
//             database: newDatabase,
//           },
//           (changeErr) => {
//             if (changeErr) {
//               console.error("Error changing database:", changeErr.message);
//               return res
//                 .status(500)
//                 .json({ error: "Failed to switch database" });
//             }
//             res.json(results);
//           }
//         );
//       }
//     });
//   }
//   if (req.body.doc_url !== undefined) {
//     const query1 =
//       "UPDATE customers SET customer_name = ?, address = ?, city = ?, state = ?, country = ?, zipcode = ?, phone = ?, doc_type = ?, doc_url = ? WHERE customers.customer_id = ?;";
//     db.query(
//       query1,
//       [
//         customer_name,
//         address,
//         city,
//         state,
//         country,
//         zipcode,
//         phone,
//         doc_type,
//         doc_url,
//         customer_id,
//       ],
//       (err, results) => {
//         if (err) {
//           console.error("Error fetching data:", err.message);
//           res.status(500).json({ error: "Failed to fetch data" });
//         } else {
//           res.send("Values Edited");
//         }
//       }
//     );
//   } else {
//     const query1 =
//       "UPDATE customers SET customer_name = ?, address = ?, city = ?, state = ?, country = ?, zipcode = ?, phone = ? WHERE customers.customer_id = ?;";
//     db.query(
//       query1,
//       [
//         customer_name,
//         address,
//         city,
//         state,
//         country,
//         zipcode,
//         phone,
//         customer_id,
//       ],
//       (err, results) => {
//         if (err) {
//           console.error("Error fetching data:", err.message);
//           res.status(500).json({ error: "Failed to fetch data" });
//         } else {
//           res.send("Values Edited");
//         }
//       }
//     );
//   }
// });

// แก้ไข /editsendaddr ให้สลับ DB ก่อน แล้วรัน UPDATE ทีเดียว ตอบกลับแค่ครั้งเดียว

app.post("/editsendaddr", async (req, res) => {
  const {
    customer_id,
    customer_name,
    address,
    city,
    state,
    country = "Thailand",
    zipcode,
    phone,
    doc_type,
    doc_url,
    emp_id,
  } = req.body;

  if (!emp_id) {
    return res.status(400).json({ error: "emp_id is required" });
  }

  try {
    // 1) สลับไปใช้ฐานข้อมูลของบริษัทผ่าน middleware/helper
    await switchToEmployeeDB(emp_id);

    // 2) สร้าง SQL และ params เบื้องต้น
    let sql =
      "UPDATE customers SET customer_name = ?, address = ?, city = ?, state = ?, country = ?, zipcode = ?, phone = ?";
    const params = [
      customer_name,
      address,
      city,
      state,
      country,
      zipcode,
      phone,
    ];

    // 3) ถ้ามี doc_type + doc_url ให้เพิ่มเข้า SQL
    if (doc_type !== undefined && doc_url !== undefined) {
      sql += ", doc_type = ?, doc_url = ?";
      params.push(doc_type, doc_url);
    }

    // 4) เติม WHERE และ customer_id
    sql += " WHERE customer_id = ?";
    params.push(customer_id);

    // 5) รันคำสั่ง UPDATE
    await q(sql, params);

    // 6) ตอบกลับผลสำเร็จ
    return res.json({ success: true, message: "Customer address updated" });
  } catch (err) {
    console.error("Error in /editsendaddr:", err);
    return res
      .status(500)
      .json({ error: err.message || "Internal server error" });
  }
});

// Setting-------------------------------------------------------------------------------------------------------------------
app.get("/company_info", (req, res) => {
  const { emp_id } = req.query;
  if (!emp_id) return res.status(400).json({ error: "emp_id is required" });

  companydb.query(
    "SELECT company_name FROM employee WHERE emp_id = ?",
    [emp_id],
    (err, results) => {
      if (err) {
        console.error("Error fetching data:", err.message);
        return res.status(500).json({ error: "Database error" });
      }

      const row = firstRowOr404(res, results);
      if (!row) return;

      const dirPath = path.join(
        process.env.RAILWAY_VOLUME_MOUNT_PATH,
        row.company_name
      );
      const filePath = path.join(dirPath, "company_info.json");

      try {
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
        if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "{}");

        const data = fs.readFileSync(filePath, "utf-8");
        res.json(JSON.parse(data));
      } catch (fsErr) {
        console.error("Filesystem error:", fsErr);
        res.status(500).json({ error: "Failed to load company information" });
      }
    }
  );
});

app.get("/dropdown", (req, res) => {
  const { emp_id } = req.query;

  // ถ้าไม่ส่ง emp_id มาเลย
  if (!emp_id) {
    return res.status(400).json({ error: "emp_id is required" });
  }

  const emptyData = { channels: [], categories: [], levels: [] };
  const sql = "SELECT * FROM `employee` WHERE `emp_id` = ?";

  companydb.query(sql, [emp_id], (err, results) => {
    if (err) {
      console.error("DB error:", err.message);
      return res.status(500).json({ error: "Failed to fetch data" });
    }

    /* ✅  จุดกันล้ม – ไม่มีพนักงานตาม emp_id */
    if (!results || results.length === 0) {
      return res.status(404).json({ error: "Employee not found" });
    }

    const companyName = results[0].company_name; // ปลอดภัยแล้ว
    const filePath = path.join(
      process.env.RAILWAY_VOLUME_MOUNT_PATH,
      companyName,
      "dropdown.json"
    );
    const dirPath = path.dirname(filePath);
    // สร้างโฟลเดอร์ถ้ายังไม่มี
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    // สร้างไฟล์เปล่าถ้ายังไม่มี
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(emptyData, null, 2));
    }

    // อ่านไฟล์และส่งกลับ
    fs.readFile(filePath, "utf-8", (err, data) => {
      if (err) {
        console.error("Read file error:", err.message);
        return res
          .status(500)
          .json({ error: "Failed to load company information" });
      }
      res.json(JSON.parse(data));
    });
  });
});

app.post("/editdropdown", (req, res) => {
  const newData = req.body;
  const uniqueChannels = [
    ...new Set(newData.channels.map((channel) => channel.name)),
  ];
  const uniqueCategories = [
    ...new Set(newData.categories.map((channel) => channel.name)),
  ];
  const uniqueLevels = [
    ...new Set(newData.levels.map((channel) => channel.name)),
  ];
  const processedData = {
    channels: uniqueChannels,
    categories: uniqueCategories,
    levels: uniqueLevels,
  };
  const emp_id = req.body.emp_id;
  const query = "SELECT * FROM `employee` WHERE `emp_id` = ?";
  companydb.query(query, [emp_id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      const file = `${results[0].company_name}/dropdown.json`;
      const filePath = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, file);
      const dirPath = path.dirname(filePath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      fs.writeFile(filePath, JSON.stringify(processedData, null, 2), (err) => {
        if (err) {
          console.error("Error writing to JSON file:", err);
        } else {
          res.send("Values Edited");
        }
      });
    }
  });
});

app.get("/price", (req, res) => {
  const { emp_id } = req.query;
  if (!emp_id) return res.status(400).json({ error: "emp_id is required" });

  companydb.query(
    "SELECT company_name FROM employee WHERE emp_id = ?",
    [emp_id],
    (err, results) => {
      if (err) {
        console.error("Error fetching data:", err.message);
        return res.status(500).json({ error: "Failed to fetch data" });
      }

      const row = firstRowOr404(res, results);
      if (!row) return; // จบงานถ้าไม่เจอพนักงาน

      const dirPath = path.join(
        process.env.RAILWAY_VOLUME_MOUNT_PATH,
        row.company_name
      );
      const filePath = path.join(dirPath, "price.json");

      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "{}");

      fs.readFile(filePath, "utf-8", (err, data) => {
        if (err) {
          console.error("Read file error:", err.message);
          return res
            .status(500)
            .json({ error: "Failed to load company information" });
        }
        res.json(JSON.parse(data));
      });
    }
  );
});

app.post("/editprice", (req, res) => {
  const emp_id = req.body.emp_id;
  const newData = req.body.updatedPricing;
  const query = "SELECT * FROM `employee` WHERE `emp_id` = ?";
  companydb.query(query, [emp_id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      const file = `${results[0].company_name}/price.json`;
      const filePath = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, file);
      const dirPath = path.dirname(filePath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      fs.writeFile(filePath, JSON.stringify(newData, null, 2), (err) => {
        if (err) {
          console.error("Error writing to JSON file:", err);
        } else {
          res.send("Values Edited");
        }
      });
    }
  });
});
app.get("/promotion", (req, res) => {
  const { emp_id } = req.query;
  if (!emp_id) return res.status(400).json({ error: "emp_id is required" });

  companydb.query(
    "SELECT company_name FROM employee WHERE emp_id = ?",
    [emp_id],
    (err, results) => {
      if (err) {
        console.error("Error fetching data:", err.message);
        return res.status(500).json({ error: "Failed to fetch data" });
      }

      const row = firstRowOr404(res, results);
      if (!row) return;

      const dirPath = path.join(
        process.env.RAILWAY_VOLUME_MOUNT_PATH,
        row.company_name
      );
      const filePath = path.join(dirPath, "promotion.json");

      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "{}");

      fs.readFile(filePath, "utf-8", (err, data) => {
        if (err) {
          console.error("Read file error:", err.message);
          return res
            .status(500)
            .json({ error: "Failed to load company information" });
        }
        res.json(JSON.parse(data));
      });
    }
  );
});

app.post("/editpromotion", (req, res) => {
  const emp_id = req.body.emp_id;
  const newData = req.body.updatedPromotions;
  const query = "SELECT * FROM `employee` WHERE `emp_id` = ?";
  companydb.query(query, [emp_id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      const file = `${results[0].company_name}/promotion.json`;
      const filePath = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, file);
      const dirPath = path.dirname(filePath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      fs.writeFile(filePath, JSON.stringify(newData, null, 2), (err) => {
        if (err) {
          console.error("Error writing to JSON file:", err);
        } else {
          res.send("Values Edited");
        }
      });
    }
  });
});

app.get("/warehouse", (req, res) => {
  const { emp_id } = req.query;
  if (!emp_id) return res.status(400).json({ error: "emp_id is required" });

  companydb.query(
    "SELECT company_name FROM employee WHERE emp_id = ?",
    [emp_id],
    (err, results) => {
      if (err) {
        console.error("Error fetching data:", err.message);
        return res.status(500).json({ error: "Failed to fetch data" });
      }

      const row = firstRowOr404(res, results);
      if (!row) return;

      const dirPath = path.join(
        process.env.RAILWAY_VOLUME_MOUNT_PATH,
        row.company_name
      );
      const filePath = path.join(dirPath, "warehouse.json");

      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "{}");

      fs.readFile(filePath, "utf-8", (err, data) => {
        if (err) {
          console.error("Read file error:", err.message);
          return res
            .status(500)
            .json({ error: "Failed to load company information" });
        }
        res.json(JSON.parse(data));
      });
    }
  );
});

app.post("/editwarehoussetting", (req, res) => {
  const emp_id = req.body.emp_id;
  const newData = req.body;
  const query = "SELECT * FROM `employee` WHERE `emp_id` = ?";
  companydb.query(query, [emp_id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      const file = `${results[0].company_name}/warehouse.json`;
      const filePath = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, file);
      const dirPath = path.dirname(filePath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      fs.writeFile(filePath, JSON.stringify(newData, null, 2), (err) => {
        if (err) {
          console.error("Error writing to JSON file:", err);
        } else {
          res.send("Values Edited");
        }
      });
    }
  });
});

app.get("/employee", (req, res) => {
  const { emp_id } = req.query;
  const query = "SELECT * FROM `employee` WHERE `emp_id` = ?";
  companydb.query(query, [emp_id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      const query = "SELECT * FROM `employee` WHERE `company_name` = ?";
      companydb.query(query, [results[0].company_name], (err, results) => {
        if (err) {
          console.error("Error fetching data:", err.message);
          res.status(500).json({ error: "Failed to fetch data" });
        } else {
          res.json(results);
        }
      });
    }
  });
});

app.get("/employeeinfo", (req, res) => {
  const { id } = req.query;
  const query = "SELECT * FROM `employee` WHERE `employee`.`emp_id` = ?;";
  companydb.query(query, [decryptEmpId(id)], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      res.json(results);
    }
  });
});

app.post("/addemployee", (req, res) => {
  const emp_name = req.body.emp_name;
  const username = req.body.username;
  const role = req.body.role;
  const password = req.body.password;
  const emp_date = req.body.emp_date;
  const emp_id = req.body.emp_id;
  const query = "SELECT * FROM `employee` WHERE `emp_id` = ?";
  companydb.query(query, [emp_id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      const query1 =
        "INSERT INTO `employee` (`username`, `emp_name`, `password`, `emp_database`, `emp_datapass`, `company_name`, `role`, `eimg`, `emp_date`) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?);";
      companydb.query(
        query1,
        [
          username,
          emp_name,
          password,
          results[0].emp_database,
          results[0].emp_datapass,
          results[0].company_name,
          role,
          emp_date,
        ],
        (err, results) => {
          if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
          } else {
            res.send("Values Edited");
          }
        }
      );
    }
  });
});

app.post("/editemployee", (req, res) => {
  const emp_id = req.body.emp_id;
  const emp_name = req.body.emp_name;
  const password = req.body.password;
  const role = req.body.role;
  const username = req.body.username;
  const query =
    "UPDATE `employee` SET `username` = ?, `emp_name` = ?, `password` = ?, `role` = ? WHERE `employee`.`emp_id` = ?;";
  companydb.query(
    query,
    [username, emp_name, password, role, emp_id],
    (err, results) => {
      if (err) {
        console.error("Error fetching data:", err.message);
        res.status(500).json({ error: "Failed to fetch data" });
      } else {
        res.json(results);
      }
    }
  );
});

app.post("/deleteemployee", (req, res) => {
  const emp_id = req.body.emp_id;
  const query1 =
    "DELETE FROM `employee` WHERE `employee`.`emp_id` = ? AND `employee`.`role` != 'owner'";
  companydb.query(query1, [emp_id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      res.send("Values Delete");
    }
  });
});

app.post("/editcompany_info", (req, res) => {
  const emp_id = req.body.emp_id;
  const query = "SELECT * FROM `employee` WHERE `emp_id` = ?";
  companydb.query(query, [emp_id], (err, results) => {
    if (err) {
      console.error("Error fetching data:", err.message);
      res.status(500).json({ error: "Failed to fetch data" });
    } else {
      const file = `${results[0].company_name}/company_info.json`;
      const filePath = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, file);
      const dirPath = path.dirname(filePath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      const newData = req.body.formData;
      fs.writeFile(filePath, JSON.stringify(newData, null, 2), (err) => {
        if (err) {
          console.error("Error writing to JSON file:", err);
          res.status(500).json({ error: "Failed to save company information" });
        }
      });
    }
  });
});

//-------------------------------------------Local Management------------------------------------------

// const multer = require("multer");

//--------------------------------------------------- IMAGE UPLOAD ---------------------------------------------------

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(
      process.env.RAILWAY_VOLUME_MOUNT_PATH,
      "uploads",
      "img"
    ); // Ensure the folder path for images
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true }); // Create directory if it doesn't exist
    }
    cb(null, uploadDir); // Specify the upload directory for images
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname); // Save with the original name provided by the client
  },
});

const uploadImage = multer({ storage: imageStorage });

// Image Upload Routes
app.post("/uploadLogo", uploadImage.single("logo"), (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res
        .status(400)
        .json({ success: false, message: "No file uploaded" });
    }

    const filePath = file.filename;
    res.status(200).json({
      success: true,
      message: "File uploaded successfully",
      filePath,
    });
  } catch (error) {
    console.error("Error handling file upload:", error.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

app.post(
  "/uploadPackageImage",
  uploadMemory.single("packageImage"),
  async (req, res) => {
    // 1) ตรวจสอบไฟล์
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "No file uploaded (field 'packageImage')" });
    }
    const { originalname, buffer } = req.file;

    // 2) ถอดรหัส emp_id
    const enc = req.query.emp_id_raw || req.query.emp_id;
    const empId = req.query.emp_id_raw ? decryptEmpId(enc) : req.query.emp_id;
    if (!empId) {
      return res.status(400).json({ error: "Invalid or missing emp_id" });
    }

    try {
      // 3) ดึง emp_database
      const rows = await new Promise((resolve, reject) => {
        companydb.query(
          "SELECT emp_database FROM employee WHERE emp_id = ?",
          [empId],
          (err, results) => (err ? reject(err) : resolve(results))
        );
      });
      if (!rows.length) {
        return res.status(404).json({ error: "Employee not found" });
      }
      const companyFolder = rows[0].emp_database;

      // 4) แปลงเป็น WebP (option)
      const uploadBuffer = await sharp(buffer).webp({ quality: 80 }).toBuffer();

      // 5) สร้าง S3 key: <emp_database>/public/package/<base>_<ts>.webp
      const baseName = path.basename(originalname, path.extname(originalname));
      const timestamp = Date.now();
      const key = `${companyFolder}/public/package/${baseName}_${timestamp}.webp`;

      // 6) สร้าง presigned URL สำหรับ PUT
      const cmd = new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET,
        Key: key,
        ContentType: "image/webp",
      });
      const presignedUrl = await getSignedUrl(s3, cmd, { expiresIn: 900 });

      // 7) สร้าง public URL (ผ่าน CloudFront หรือ S3 ตรง)
      const publicUrl = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

      return res.json({ presignedUrl, publicUrl });
    } catch (err) {
      console.error("Error in /uploadPackageImage:", err);
      return res
        .status(500)
        .json({ error: err.message || "Internal server error" });
    }
  }
);

app.post(
  "/uploadItemImage",
  uploadMemory.single("itemImage"),
  async (req, res) => {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "No file uploaded (field 'itemImage')" });
    }

    // ถอด emp_id ปกติ
    const enc = req.query.emp_id_raw || req.query.emp_id;
    const empId = req.query.emp_id_raw ? decryptEmpId(enc) : req.query.emp_id;
    if (!empId)
      return res.status(400).json({ error: "Invalid or missing emp_id" });

    try {
      // หาชื่อโฟลเดอร์บริษัท
      const rows = await new Promise((resolve, reject) => {
        companydb.query(
          "SELECT emp_database FROM employee WHERE emp_id = ?",
          [empId],
          (err, results) => (err ? reject(err) : resolve(results))
        );
      });
      if (!rows.length)
        return res.status(404).json({ error: "Employee not found" });
      const companyFolder = rows[0].emp_database;

      // แปลงไฟล์เป็น WebP
      const webpBuffer = await sharp(req.file.buffer)
        .webp({ quality: 80 })
        .toBuffer();

      // อ่านชื่อไฟล์ใหม่จาก client หรือ fallback ไปใช้ชื่อเดิม + timestamp
      const { fileName } = req.body; // จาก FormData
      let key;
      if (fileName) {
        // ถ้า client ส่งชื่อมา ก็ใช้ key นี้เลย
        key = `${companyFolder}/public/item/${fileName.replace(
          /\.[^/.]+$/,
          ".webp"
        )}`;
      } else {
        // ถ้าไม่ส่ง มาสร้าง key เอง
        const originalname = req.file.originalname;
        const baseName = path.basename(
          originalname,
          path.extname(originalname)
        );
        const timestamp = Date.now();
        key = `${companyFolder}/public/item/${baseName}_${timestamp}.webp`;
      }

      // สร้าง presigned PUT URL
      const cmd = new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET,
        Key: key,
        ContentType: "image/webp",
      });
      const presignedUrl = await getSignedUrl(s3, cmd, { expiresIn: 900 });

      // publicUrl สำหรับบันทึกใน DB
      const publicUrl = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

      return res.json({ presignedUrl, publicUrl });
    } catch (err) {
      console.error("Error in /uploadItemImage:", err);
      return res
        .status(500)
        .json({ error: err.message || "Internal server error" });
    }
  }
);

app.post("/uploadSlip", uploadImage.single("slip"), (req, res) => {
  try {
    const { file } = req;
    if (!file) {
      return res
        .status(400)
        .json({ success: false, message: "No file uploaded" });
    }

    // Log the file path and other metadata if needed
    res.status(200).json({ success: true, filePath: file.filename });
  } catch (error) {
    console.error("Error uploading slip:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// Updated /uploadVerifyImg endpoint: logs full errors for easier debugging
app.post(
  "/uploadVerifyImg",
  uploadMemory.single("verifyImg"),
  async (req, res) => {
    // 1) Ensure file present
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "No file uploaded. Ensure field name is 'verifyImg'." });
    }

    const { originalname, buffer } = req.file;
    // 2) Determine encrypted vs. decrypted emp_id
    const encryptedEmpId = req.query.emp_id_raw || req.query.emp_id;
    let decryptedEmpId;

    if (req.query.emp_id_raw) {
      decryptedEmpId = decryptEmpId(encryptedEmpId);
      if (!decryptedEmpId) {
        return res.status(400).json({ error: "Invalid emp_id provided" });
      }
    } else if (req.query.emp_id) {
      // Already decrypted by middleware
      decryptedEmpId = req.query.emp_id;
    } else {
      return res.status(400).json({ error: "emp_id is required" });
    }

    try {
      // 3) Lookup emp_database to form S3 folder
      const rows = await new Promise((resolve, reject) => {
        companydb.query(
          "SELECT emp_database FROM employee WHERE emp_id = ?",
          [decryptedEmpId],
          (err, results) => (err ? reject(err) : resolve(results))
        );
      });

      if (!rows || rows.length === 0) {
        return res.status(404).json({ error: "Employee not found" });
      }
      const companyFolder = rows[0].emp_database;

      // 4) Convert to WebP
      const webpBuffer = await sharp(buffer).webp({ quality: 80 }).toBuffer();

      // 5) Generate S3 key
      const baseName = path.basename(originalname, path.extname(originalname));
      const prefix = process.env.AWS_S3_PREFIX || "uploads";
      const s3Key = `${companyFolder}/${prefix}/${baseName}.webp`;

      // 6) Create presigned PUT URL
      const putCommand = new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET,
        Key: s3Key,
        ContentType: "image/webp",
      });
      const presignedUrl = await getSignedUrl(s3, putCommand, {
        expiresIn: 900,
      });
      const publicUrl = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;

      return res.json({ presignedUrl, publicUrl });
    } catch (err) {
      console.error("Error in /uploadVerifyImg:", err);
      // Send full error message back for debugging
      return res
        .status(500)
        .json({ error: err.message || "Internal server error" });
    }
  }
);

app.post("/deleteLogoImages", (req, res) => {
  try {
    // Define the directory where the images are stored
    const { photo_url } = req.body;
    const directoryPath = path.join(
      process.env.RAILWAY_VOLUME_MOUNT_PATH,
      "uploads",
      "img"
    ); // Replace "uploads" with your directory
    if (fs.existsSync(directoryPath)) {
      // Read all files in the directory
      fs.readdir(directoryPath, (err, files) => {
        if (err) {
          console.error("Error reading directory:", err);
          return res
            .status(500)
            .json({ success: false, message: "Error reading directory" });
        }

        // Filter files starting with "logo"
        const logoFiles = files.filter((file) => file.startsWith(photo_url));
        // Delete each matching file
        if (logoFiles.length > 0) {
          const filePath = path.join(directoryPath, logoFiles[0]);
          fs.unlink(filePath, (err) => {
            if (err) {
              console.error(`Error deleting file ${logoFiles[0]}:`, err);
            } else {
              console.log(`Deleted file: ${logoFiles[0]}`);
            }
          });
        }
        res.status(200).json({
          success: true,
          message: `Deleted ${logoFiles.length} logo image(s)`,
        });
      });
    } else {
      res.status(200).json({
        success: true,
        message: `Deleted 0 logo image(s)`,
      });
    }
  } catch (error) {
    console.error("Error handling delete request:", error.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

app.post("/deletePackageImages", (req, res) => {
  try {
    // Define the directory where the images are stored
    const { photo_url } = req.body;
    const directoryPath = path.join(
      process.env.RAILWAY_VOLUME_MOUNT_PATH,
      "uploads",
      "img"
    ); // Replace "uploads" with your directory
    // Read all files in the directory

    fs.readdir(directoryPath, (err, files) => {
      if (err) {
        console.error("Error reading directory:", err);
        return res
          .status(500)
          .json({ success: false, message: "Error reading directory" });
      }

      // Filter files starting with "logo"
      const logoFiles = files.filter((file) => file.startsWith(photo_url));
      // Delete each matching file
      logoFiles.forEach((file) => {
        const filePath = path.join(directoryPath, file);
        fs.unlink(filePath, (err) => {
          if (err) {
            console.error(`Error deleting file ${filePath}:`, err);
          } else {
            console.log(`Deleted file: ${filePath}`);
          }
        });
      });
      res.status(200).json({
        success: true,
        message: `Deleted ${logoFiles.length} logo image(s)`,
      });
    });
  } catch (error) {
    console.error("Error handling delete request:", error.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

app.post("/deleteImagesByName", (req, res) => {
  try {
    const { photo_url } = req.body; // Expecting an array of filenames from the client
    // Define the directory where the images are stored
    const directoryPath = path.join(
      process.env.RAILWAY_VOLUME_MOUNT_PATH,
      "uploads",
      "img"
    ); // Replace with your directory
    // Iterate through the provided filenames and delete them
    if (photo_url !== undefined) {
      const filePath = path.join(directoryPath, photo_url);
      // Check if the file exists before attempting to delete

      if (fs.existsSync(filePath)) {
        fs.unlink(filePath, (err) => {
          if (err) {
            console.error(`Error deleting file ${photo_url}:`, err.message);
          } else {
            console.log(`Deleted file: ${photo_url}`);
          }
        });
      }
    }
    res.status(200).json({
      success: true,
      message: `Deleted file successfully`,
    });
  } catch (error) {
    console.error("Error handling delete request:", error.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});
//--------------------------------------------------- DOCUMENT UPLOAD ---------------------------------------------------

app.use(
  "/uploads/img",
  express.static(
    path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "uploads", "img")
  )
);

// Enhanced storage configuration
const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(
      process.env.RAILWAY_VOLUME_MOUNT_PATH,
      "uploads",
      "doc"
    );
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Replace forbidden characters
    const sanitizedFilename = file.originalname.replace(/[:<>|?*"]/g, "_");
    console.log("Sanitized filename:", sanitizedFilename);
    cb(null, sanitizedFilename);
  },
});

const uploadDocument = multer({ storage: documentStorage });

app.post("/uploadDocument", uploadDocument.single("document"), (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      console.error("No file received");
      return res
        .status(400)
        .json({ success: false, message: "No file uploaded" });
    }

    // Failsafe: Check directory existence after upload
    const uploadDir = path.resolve(
      process.env.RAILWAY_VOLUME_MOUNT_PATH,
      "uploads",
      "doc"
    );
    if (!fs.existsSync(uploadDir)) {
      console.error("Upload directory missing after upload:", uploadDir);
      throw new Error("Upload directory vanished unexpectedly.");
    }

    const savedPath = path.join(
      process.env.RAILWAY_VOLUME_MOUNT_PATH,
      "uploads",
      "doc",
      file.originalname
    );
    console.log("File saved successfully at:", savedPath);

    res.status(200).json({
      success: true,
      message: "File uploaded successfully",
      filePath: savedPath,
    });
  } catch (error) {
    console.error("Error during Multer upload:", error.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// มั่วอันนี้
app.get("/searchByTracking", async (req, res) => {
  const { trackingNumber } = req.query;

  try {
    // Example query
    const result = await db.query(
      `
            SELECT customers.customer_id, customers.contact, customers.type, customers.level, customers.note
            FROM customers
            INNER JOIN packages ON customers.customer_id = packages.customer_id
            WHERE packages.tracking_number = ?
        `,
      [trackingNumber]
    );

    // Convert result to plain JSON
    const plainResult = JSON.parse(JSON.stringify(result));
    res.json(plainResult);
  } catch (error) {
    console.error("Error fetching customer by tracking number:", error);
    res.status(500).send("Error fetching customer");
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Server is running on ${PORT}`);
});
