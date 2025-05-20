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

// It's good practice to check for essential environment variables at startup
const requiredEnvVars = [
  "AWS_REGION",
  "AWS_ACCESS_KEY",
  "AWS_SECRET_KEY",
  "AWS_BUCKET",
  "EMP_ID_KEY",
  "RAILWAY_VOLUME_MOUNT_PATH",
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.warn(`Warning: Environment variable ${envVar} is not set.`);
    // Depending on the variable, you might want to throw an error and exit
    // if (envVar === "RAILWAY_VOLUME_MOUNT_PATH") { // Example critical var
    //   throw new Error(`${envVar} is required and not set.`);
    // }
  }
}


process.env.AWS_S3_DISABLE_CHECKSUMS = "true"; // ปิด CRC32 placeholder
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

const s3ClientConfig = {
  region: process.env.AWS_REGION,
};
if (process.env.AWS_ACCESS_KEY && process.env.AWS_SECRET_KEY) {
  s3ClientConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_KEY,
  };
} else {
    console.warn("AWS credentials (AWS_ACCESS_KEY, AWS_SECRET_KEY) are not set. S3 operations might fail if IAM roles are not configured.");
}

const s3 = new S3Client(s3ClientConfig);

/* ===== AES key (ควรเก็บใน .env) ===== */
const EMP_KEY = process.env.EMP_ID_KEY || "sky45678you"; // This default is for development only.

function decryptEmpId(enc) {
  if (!enc || typeof enc !== 'string') return null;
  try {
    const encrypted =
      enc.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (enc.length % 4)) % 4);
    const bytes = CryptoJS.AES.decrypt(encrypted, EMP_KEY);
    const plain = bytes.toString(CryptoJS.enc.Utf8);
    return plain || null;
  } catch (error) {
    console.error("Error decrypting emp_id:", error.message);
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
    } else {
      // Optional: handle invalid encrypted emp_id in query
      // console.warn("Failed to decrypt emp_id from query:", req.query.emp_id);
      // req.query.emp_id = null; // Or remove it, or send an error
    }
  }
  if (req.body && req.body.emp_id) {
    const plain = decryptEmpId(req.body.emp_id);
    if (plain) {
      req.body.emp_id_raw = req.body.emp_id;
      req.body.emp_id = plain;
    } else {
      // Optional: handle invalid encrypted emp_id in body
      // console.warn("Failed to decrypt emp_id from body:", req.body.emp_id);
      // req.body.emp_id = null;
    }
  }
  next();
});

const dbConfig = {
  host: process.env.DB_HOST || "th257.ruk-com.in.th",
  user: process.env.DB_USER || "sharebil_sky4you",
  password: process.env.DB_PASSWORD || "LN5avYu2KUwGDR6Ytreg",
  port: process.env.DB_PORT || "3306",
  database: process.env.DB_NAME || "sharebil_sky4you",
  timezone: "+07:00",
};

const db = mysql.createConnection(dbConfig);
const companydb = mysql.createConnection(dbConfig); // Assuming companydb uses the same initial credentials

db.connect(err => {
  if (err) {
    console.error("Error connecting to main DB:", err.stack);
    return;
  }
  console.log("Connected to main DB as id", db.threadId);
});

companydb.connect(err => {
  if (err) {
    console.error("Error connecting to company DB:", err.stack);
    return;
  }
  console.log("Connected to company DB as id", companydb.threadId);
});


/**
 * ดึง S3 object key จาก URL ของ S3
 * @param {string} url URL เต็มของ S3
 * @returns {string|null} S3 object key หรือ null ถ้า URL ไม่ถูกต้อง
 */
function extractS3KeyFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const urlObject = new URL(url);
    if (urlObject.hostname.endsWith(".amazonaws.com")) {
      return urlObject.pathname.startsWith("/")
        ? urlObject.pathname.substring(1)
        : urlObject.pathname;
    }
    return null;
  } catch (e) {
    console.error("URL ไม่ถูกต้องสำหรับการดึง S3 key:", url, e.message);
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
  if (!process.env.AWS_BUCKET) {
    console.error("AWS_BUCKET environment variable is not set. Cannot delete S3 object.");
    return;
  }
  try {
    const command = new DeleteObjectCommand({
      Bucket: process.env.AWS_BUCKET,
      Key: s3Key,
    });
    await s3.send(command);
    console.log(`ลบอ็อบเจกต์ S3 สำเร็จ: ${s3Key}`);
  } catch (error) {
    console.error(`ไม่สามารถลบอ็อบเจกต์ S3 ${s3Key}:`, error.message);
  }
}

/* ---------- helper : แปลง db.query ให้คืน Promise ---------- */
function q(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function switchToEmployeeDB(emp_id) {
  return new Promise((resolve, reject) => {
    if (!emp_id) {
      // console.log("No emp_id provided, not switching DB.");
      return resolve(); // ไม่ได้ส่ง emp_id มาก็ไม่ต้องสลับ DB
    }

    companydb.query(
      "SELECT emp_database, emp_datapass FROM employee WHERE emp_id = ?",
      [emp_id],
      (err, rows) => {
        if (err) return reject({ status: 500, msg: "Database error during employee lookup", err });
        if (!rows || rows.length === 0)
          return reject({ status: 404, msg: `Employee not found for emp_id: ${emp_id}` });

        const { emp_database, emp_datapass } = rows[0];
        if (!emp_database || !emp_datapass) { // Added check for null/empty credentials
            return reject({ status: 500, msg: `Database credentials not found for employee: ${emp_id}` });
        }

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
                msg: `Failed to switch database to ${emp_database}`,
                err: changeErr,
              });
            // console.log(`Switched DB connection to ${emp_database} for emp_id: ${emp_id}`);
            resolve(); // สลับสำเร็จ
          }
        );
      }
    );
  });
}

function firstRowOr404(res, rows, notFoundMsg = "Resource not found") {
  if (!rows || rows.length === 0) {
    res.status(404).json({ error: notFoundMsg });
    return null;
  }
  return rows[0];
}

// Login-------------------------------------------------------------------------------------------------------------------
app.post("/login", (req, res) => {
  if (!req.body) {
    return res.status(400).json({ error: "Request body is missing" });
  }
  // emp_id in body is already decrypted by middleware if it was encrypted
  const byEmpId = req.body.emp_id !== undefined && req.body.emp_id !== null;

  let sql, params;
  if (byEmpId) {
    sql = "SELECT * FROM `employee` WHERE `emp_id` = ?";
    params = [req.body.emp_id];
  } else {
    if (req.body.username === undefined || req.body.password === undefined) {
      return res.status(400).json({ error: "Username and password are required for standard login" });
    }
    sql = "SELECT * FROM `employee` WHERE `username` = ? AND `password` = ?";
    params = [req.body.username, req.body.password];
  }

  companydb.query(sql, params, (err, results) => {
    if (err) {
      console.error("Error fetching data during login:", err.message);
      return res.status(500).json({ error: "Failed to fetch data" });
    }

    if (!results || results.length === 0) {
      return res
        .status(401)
        .json({ error: "Invalid credentials or employee not found" });
    }

    const employee = results[0];
    if (!employee.emp_database || !employee.emp_datapass) {
        console.error(`Missing database credentials for employee: ${employee.emp_id}`);
        return res.status(500).json({ error: "Configuration error: Employee database details are missing." });
    }

    db.changeUser(
      {
        user: employee.emp_database,
        password: employee.emp_datapass,
        database: employee.emp_database,
      },
      (changeErr) => {
        if (changeErr) {
          console.error("Error changing database during login:", changeErr.message);
          return res.status(500).json({ error: "Failed to switch database" });
        }
        return res.json(results); // Send original employee data
      }
    );
  });
});

app.post("/logout", (req, res) => {
  db.changeUser( // Revert to default credentials
    {
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
    },
    (changeErr) => {
      if (changeErr) {
        console.error("Error changing database during logout:", changeErr.message);
        return res.status(500).json({ error: "Failed to switch database" });
      }
      res.json({ message: "Logout successful, connection reverted to default." });
    }
  );
});

// Home-------------------------------------------------------------------------------------------------------------------
app.get("/allcustomers", async (req, res) => {
  try {
    // This query seems complex and might be inefficient on large datasets. Consider optimizing.
    // The original query for /allcustomers had a complex subquery.
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
             COUNT(DISTINCT p.tracking_number) AS package_count 
             /* Using DISTINCT for package_count to avoid issues if items join multiplies rows */
      FROM customers c
      LEFT JOIN packages p ON c.customer_id = p.customer_id
      /* 
        The NOT EXISTS condition seems to exclude customers if ALL their packages have ALL items with status 1.
        If a customer has one package fully status 1, and another package not, they might still appear.
        Clarify the exact logic needed for "package_count" if this isn't intended.
      */
      WHERE (p.tracking_number IS NULL OR NOT EXISTS ( 
          SELECT 1
          FROM items i
          WHERE i.tracking_number = p.tracking_number
          GROUP BY i.tracking_number
          HAVING MIN(i.item_status) = 1 AND MAX(i.item_status) = 1 
      ))
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
  if (!req.body || !req.body.customer_id) {
    return res
      .status(400)
      .json({ success: false, message: "Customer ID is required in body" });
  }
  const { customer_id } = req.body;

  db.beginTransaction(async (txErr) => {
    if (txErr) {
      console.error("Error starting transaction for deleteCustomer:", txErr.message);
      return res
        .status(500)
        .json({ success: false, message: "Failed to start transaction" });
    }

    try {
      const packagesToDelete = await q(
        "SELECT tracking_number, photo_url FROM packages WHERE customer_id = ?",
        [customer_id]
      );

      for (const pkg of packagesToDelete) {
        if (pkg.photo_url) {
          const packageS3Key = extractS3KeyFromUrl(pkg.photo_url);
          if (packageS3Key) await deleteS3Object(packageS3Key);
        }

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

      const statements = [
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
        `DELETE FROM addresses WHERE customer_id = ?`,
        `DELETE FROM customers WHERE customer_id = ?`,
      ];

      for (const sql of statements) {
        // All these statements use customer_id as the parameter.
        // If any used a different parameter, it would need adjustment.
        await q(sql, [customer_id]);
      }

      db.commit((commitErr) => {
        if (commitErr) {
          console.error("Commit error for deleteCustomer:", commitErr.message);
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
          error: err.message // Provide error message for debugging
        })
      );
    }
  });
});

// Customer-------------------------------------------------------------------------------------------------------------------
app.get("/customersDetails", async (req, res) => {
  const { id, emp_id } = req.query; // emp_id is already decrypted by middleware

  if (!id)
    return res.status(400).json({ error: "customer_id (id) is required" });

  try {
    await switchToEmployeeDB(emp_id); // emp_id can be null/undefined, switchToEmployeeDB handles it
    const rows = await q("SELECT * FROM customers WHERE customer_id = ?", [id]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "Customer details not found" });
    }
    return res.json(rows);
  } catch (e) {
    console.error("Error in /customersDetails:", e.msg || e.message, e.err || '');
    return res.status(e.status || 500).json({ error: e.msg || "Error fetching customer details" });
  }
});

app.get("/addressesinfo", async (req, res) => {
  const { id, emp_id } = req.query; // emp_id for potential DB switch

  if (!id)
    return res.status(400).json({ error: "address_id (id) is required" });

  try {
    await switchToEmployeeDB(emp_id); // Switch DB if emp_id is provided
    const rows = await q("SELECT * FROM addresses WHERE address_id = ?", [id]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "Address info not found" });
    }
    return res.json(rows);
  } catch (e) {
    console.error("Error in /addressesinfo:", e.msg || e.message, e.err || '');
    return res.status(e.status || 500).json({ error: e.msg || "Error fetching address info" });
  }
});

app.get("/customersaddresses", async (req, res) => {
  const { id, emp_id } = req.query;

  if (!id)
    return res.status(400).json({ error: "customer_id (id) is required" });

  try {
    await switchToEmployeeDB(emp_id);
    const rows = await q("SELECT * FROM addresses WHERE customer_id = ?", [id]);
    // It's okay if a customer has no addresses, return empty array.
    return res.json(rows);
  } catch (e) {
    console.error("Error in /customersaddresses:", e.msg || e.message, e.err || '');
    return res.status(e.status || 500).json({ error: e.msg || "Error fetching customer addresses" });
  }
});

app.get("/customerspackages", async (req, res) => {
  const { id, emp_id } = req.query;

  try {
    await switchToEmployeeDB(emp_id);
    const processedId = id ?? null;
    const sql = `
      SELECT
        p.*,
        p.Date_create AS received_date, /* Ensure Date_create column exists and is populated */
        COALESCE(SUM(CASE WHEN i.item_status = 0 THEN 1 ELSE 0 END), 0) AS sum0,
        COALESCE(SUM(CASE WHEN i.item_status = 1 THEN 1 ELSE 0 END), 0) AS sum1
      FROM packages p
      LEFT JOIN items i ON p.tracking_number = i.tracking_number
      WHERE ${processedId === null ? "p.customer_id IS NULL" : "p.customer_id = ?"}
      GROUP BY p.tracking_number, p.Date_create /* Added p.Date_create to GROUP BY for SQL standard */
      ORDER BY p.Date_create DESC; /* Assuming Date_create is how you want to order */
    `;
    const params = processedId === null ? [] : [processedId];
    const rows = await q(sql, params);
    return res.json(rows);
  } catch (e) {
    console.error("Error in /customerspackages:", e.msg || e.message, e.err || '');
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch customer packages" });
  }
});

app.get("/nullpackages", async (req, res) => { // Added emp_id for consistency
  const { emp_id } = req.query;
  try {
    await switchToEmployeeDB(emp_id);
    const rows = await q(
      "SELECT p.*, p.Date_create AS received_date FROM packages p WHERE p.customer_id IS NULL ORDER BY p.Date_create DESC"
    );
    return res.json(rows);
  } catch (e) {
    console.error("Error in /nullpackages:", e.msg || e.message, e.err || '');
    return res.status(e.status || 500).json({ error: e.msg || "Failed to fetch null-customer packages" });
  }
});

app.get("/item", async (req, res) => {
  const { id, emp_id } = req.query;

  if (!id)
    return res.status(400).json({ error: "tracking_number (id) is required" });

  try {
    await switchToEmployeeDB(emp_id);
    const rows = await q(
      "SELECT * FROM items WHERE tracking_number = ? AND item_status = 0",
      [id]
    );
    return res.json(rows);
  } catch (e) {
    console.error("Error in /item:", e.msg || e.message, e.err || '');
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch items by tracking number" });
  }
});

app.post("/additems", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { customer_id, tracking_number, items, emp_id } = req.body;

  if (!customer_id || !tracking_number || !Array.isArray(items)) {
    return res.status(400).json({ error: "Missing or invalid data: customer_id, tracking_number, or items array is required." });
  }

  const values = items
    .filter((it) => it && typeof it.name === 'string' && it.name.trim() !== '' && typeof it.mainCategory === 'string' && it.mainCategory.trim() !== '')
    .map((it) => [
      tracking_number,
      it.name.trim(),
      it.mainCategory.trim(),
      it.subCategory?.trim() ?? "", // Ensure subCategory is also trimmed if present
      Number(it.quantity) || 0,
      Number(it.weight) || 0,
      null, // packer_id
      it.photo_url || null,
    ]);

  if (values.length === 0) {
    return res.status(400).json({ error: "No valid items to insert. Ensure item has name and mainCategory." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    await q(
      "INSERT INTO items (tracking_number,item_name,item_type,item_subtype,quantity,weight,packer_id,photo_url) VALUES ?",
      [values]
    );
    await q(
      "UPDATE customers SET status = 'Warehouse' WHERE (status IS NULL OR status != 'Unpaid') AND customer_id = ?",
      [customer_id]
    );
    return res.json({ message: "Items added and customer status updated successfully." });
  } catch (e) {
    console.error("Error in /additems:", e.msg || e.message, e.err || '');
    return res.status(e.status || 500).json({ error: e.msg || "Failed to add items" });
  }
});

app.post("/edititem", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const {
    item_id,
    item_name,
    item_type,
    item_subtype,
    quantity,
    weight,
    photo_url,
    emp_id,
  } = req.body;

  if (!item_id || !item_name || !item_type) { // Basic validation
    return res.status(400).json({ error: "Missing required data: item_id, item_name, item_type." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    await q(
      `UPDATE items
           SET item_name   = ?,
               item_type   = ?,
               item_subtype= ?,
               quantity    = ?,
               weight      = ?,
               photo_url   = ?
         WHERE item_id = ?`,
      [
        item_name.trim(),
        item_type.trim(),
        item_subtype?.trim() ?? "",
        Number(quantity) || 0,
        Number(weight) || 0,
        photo_url || null,
        item_id,
      ]
    );
    return res.json({ message: "Item edited successfully." });
  } catch (e) {
    console.error("Error in /edititem:", e.msg || e.message, e.err || '');
    return res.status(e.status || 500).json({ error: e.msg || "Failed to edit item" });
  }
});

app.post("/deleteitem", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { customer_id, item_id, emp_id } = req.body;

  if (!item_id) {
    return res.status(400).json({ error: "Missing item_id" });
  }

  try {
    await switchToEmployeeDB(emp_id);

    db.beginTransaction(async (txErr) => {
      if (txErr) {
        console.error("Transaction start error in /deleteitem:", txErr.message);
        return res.status(500).json({ error: "Transaction error", details: txErr.message });
      }

      try {
        const [itemToDelete] = await q(
          "SELECT photo_url FROM items WHERE item_id = ?",
          [item_id]
        );

        if (itemToDelete && itemToDelete.photo_url) {
          const s3Key = extractS3KeyFromUrl(itemToDelete.photo_url);
          if (s3Key) {
            await deleteS3Object(s3Key);
          }
        }

        const deleteResult = await q("DELETE FROM items WHERE item_id = ?", [item_id]);
        if (deleteResult.affectedRows === 0) {
          // Item not found, or already deleted. Consider how to handle.
          // Maybe rollback and send 404, or commit and inform. For now, proceed.
          console.warn(`Item with id ${item_id} not found for deletion or already deleted.`);
        }


        let message = "Item deleted successfully.";
        if (customer_id) { // Only update customer status if customer_id is provided
          const [{ count }] = await q(
            `SELECT COUNT(*) AS count
             FROM items i
             JOIN packages p ON i.tracking_number = p.tracking_number
             WHERE p.customer_id = ? AND i.item_status = 0`,
            [customer_id]
          );

          if (count === 0) {
            await q(
              "UPDATE customers SET status = NULL WHERE customer_id = ? AND (status = 'Warehouse' OR status IS NULL)", // More specific update
              [customer_id]
            );
            message = "Item deleted and customer status potentially updated.";
          }
        }

        db.commit((commitErr) => {
          if (commitErr) {
            console.error("Commit error in /deleteitem:", commitErr.message);
            return db.rollback(() =>
              res.status(500).json({ error: "Commit failed", details: commitErr.message })
            );
          }
          return res.json({ message });
        });
      } catch (err) {
        console.error("Error during /deleteitem transaction:", err.message);
        db.rollback(() =>
          res.status(500).json({ error: "Failed to delete item", details: err.message })
        );
      }
    });
  } catch (e) { // Catch errors from switchToEmployeeDB
    console.error("Error switching DB for /deleteitem:", e.msg || e.message, e.err || '');
    return res.status(e.status || 500).json({ error: e.msg || "DB switch failed" });
  }
});


// เเก้ไขต่อด้านล่าง (These routes use callbacks, consider refactoring to async/await q())

app.post("/editwarehouse", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { customer_id: id, warehouse, emp_id } = req.body;

  if (!id || warehouse === undefined) {
    return res.status(400).json({ error: "customer_id and warehouse are required." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    await q("UPDATE `customers` SET `warehouse` = ? WHERE `customers`.`customer_id` = ?;", [warehouse, id]);
    res.json({ message: "Warehouse updated successfully." });
  } catch (e) {
    console.error("Error in /editwarehouse:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to update warehouse." });
  }
});

app.post("/createcus", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { customer_id: id, contact, type, level, note, emp_id } = req.body;

  if (!id || !contact) { // Example: id and contact are mandatory
    return res.status(400).json({ error: "customer_id and contact are required." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    const result = await q(
      "INSERT INTO `customers` (`customer_id`, `contact`, `type`, `level`, `note`) VALUES (?, ?, ?, ?, ?);",
      [id, contact, type, level, note]
    );
    res.json({ message: "Customer created successfully.", customerId: id, insertId: result.insertId });
  } catch (e) {
    console.error("Error in /createcus:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to create customer." });
  }
});

app.post("/editcus", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { old_id, customer_id: id, contact, type, level, note, emp_id } = req.body;

  if (!old_id || !id || !contact) { // Example: old_id, new id, and contact are mandatory
    return res.status(400).json({ error: "old_id, customer_id, and contact are required." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    await q(
      "UPDATE customers SET customer_id = ?, contact = ?, type = ?, level = ?, note = ? WHERE customer_id = ?;",
      [id, contact, type, level, note, old_id]
    );
    res.json({ message: "Customer edited successfully." });
  } catch (e) {
    console.error("Error in /editcus:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to edit customer." });
  }
});

app.post("/addaddr", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const {
    customer_id, recipient_name, phone, address, city, state, country, zipcode, email, emp_id
  } = req.body;

  if (!customer_id || !recipient_name || !address || !city || !country || !zipcode) {
    return res.status(400).json({ error: "Missing required address fields." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    const result = await q(
      "INSERT INTO `addresses` (`customer_id`, `recipient_name`, `phone`, `address`, `city`, `state`, `country`, `zipcode`, `email`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);",
      [customer_id, recipient_name, phone, address, city, state, country, zipcode, email]
    );
    res.json({ message: "Address added successfully.", addressId: result.insertId });
  } catch (e) {
    console.error("Error in /addaddr:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to add address." });
  }
});

app.post("/editaddr", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const {
    address_id, recipient_name, phone, address, city, state, country, zipcode, emp_id
  } = req.body;

  if (!address_id || !recipient_name || !address || !city || !country || !zipcode) {
    return res.status(400).json({ error: "Missing required address fields for editing." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    await q(
      "UPDATE `addresses` SET `recipient_name` = ?, `phone` = ?, `address` = ?, `city` = ?, `state` = ?, `country` = ?, `zipcode` = ? WHERE `address_id` = ?;",
      [recipient_name, phone, address, city, state, country, zipcode, address_id]
    );
    res.json({ message: "Address edited successfully." });
  } catch (e) {
    console.error("Error in /editaddr:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to edit address." });
  }
});

app.post("/deleteaddr", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { address_id, emp_id } = req.body;

  if (!address_id) {
    return res.status(400).json({ error: "address_id is required." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    const result = await q("DELETE FROM addresses WHERE `addresses`.`address_id` = ?;", [address_id]);
    if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Address not found or already deleted." });
    }
    res.json({ message: "Address deleted successfully." });
  } catch (e) {
    console.error("Error in /deleteaddr:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to delete address." });
  }
});

app.post("/addpackage", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { customer_id, tracking_number, photo_url, packages_cost, emp_id } = req.body;

  if (!tracking_number) { // tracking_number is essential
    return res.status(400).json({ error: "tracking_number is required." });
  }
  const processedcustomer_id = (customer_id === "MISSINGITEMS" || customer_id === "" || customer_id === undefined) ? null : customer_id;

  try {
    await switchToEmployeeDB(emp_id);
    let sql, params;
    if (packages_cost !== undefined) {
      sql = "INSERT INTO `packages` (`tracking_number`, `customer_id`, `packages_cost`, `photo_url`) VALUES (?, ?, ?, ?);";
      params = [tracking_number, processedcustomer_id, Number(packages_cost) || 0, photo_url || null];
    } else {
      sql = "INSERT INTO `packages` (`tracking_number`, `customer_id`, `photo_url`) VALUES (?, ?, ?);";
      params = [tracking_number, processedcustomer_id, photo_url || null];
    }
    await q(sql, params);
    res.json({ message: "Package added successfully." });
  } catch (e) {
    console.error("Error in /addpackage:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to add package." });
  }
});

app.post("/editpackage", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { old_id, customer_id, tracking_number, photo_url, emp_id } = req.body;

  if (!old_id || !tracking_number) {
    return res.status(400).json({ error: "old_id (original tracking number) and new tracking_number are required." });
  }
  const processedcustomer_id = (customer_id === "MISSINGITEMS" || customer_id === "" || customer_id === undefined) ? null : customer_id;

  try {
    await switchToEmployeeDB(emp_id);
    await q(
      "UPDATE `packages` SET `tracking_number` = ?, `customer_id` = ?, `photo_url` = ? WHERE `packages`.`tracking_number` = ?;",
      [tracking_number, processedcustomer_id, photo_url || null, old_id]
    );
    res.json({ message: "Package edited successfully." });
  } catch (e) {
    console.error("Error in /editpackage:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to edit package." });
  }
});

app.post("/deletepackage", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { customer_id, tracking, emp_id } = req.body;

  if (!tracking) {
    return res.status(400).json({ error: "Tracking number (tracking) is required" });
  }

  try {
    await switchToEmployeeDB(emp_id);
    db.beginTransaction(async (txErr) => {
      if (txErr) {
        console.error("Transaction start error in /deletepackage:", txErr.message);
        return res.status(500).json({ error: "Transaction error", details: txErr.message });
      }

      try {
        const [packageData] = await q(
          "SELECT photo_url FROM packages WHERE tracking_number = ?",
          [tracking]
        );
        if (packageData && packageData.photo_url) {
          const packageS3Key = extractS3KeyFromUrl(packageData.photo_url);
          if (packageS3Key) await deleteS3Object(packageS3Key);
        }

        const itemsInPackage = await q(
          "SELECT item_id, photo_url FROM items WHERE tracking_number = ?",
          [tracking]
        );
        for (const item of itemsInPackage) {
          if (item.photo_url) {
            const itemS3Key = extractS3KeyFromUrl(item.photo_url);
            if (itemS3Key) await deleteS3Object(itemS3Key);
          }
        }

        await q("DELETE FROM items WHERE tracking_number = ?", [tracking]);
        const packageDeleteResult = await q("DELETE FROM packages WHERE tracking_number = ?", [tracking]);

        if (packageDeleteResult.affectedRows === 0) {
            // Package not found, or already deleted.
            console.warn(`Package with tracking ${tracking} not found for deletion or already deleted.`);
        }

        let message = "Package and associated items deleted successfully.";
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
              "UPDATE customers SET status = NULL WHERE customer_id = ? AND (status = 'Warehouse' OR status IS NULL)",
              [customer_id]
            );
            message = "Package and items deleted. Customer status potentially updated.";
          }
        }

        db.commit((commitErr) => {
          if (commitErr) {
            console.error("Commit error in /deletepackage:", commitErr.message);
            return db.rollback(() =>
              res.status(500).json({ error: "Failed to commit transaction", details: commitErr.message })
            );
          }
          res.json({ message });
        });
      } catch (err) {
        console.error("Error during /deletepackage transaction:", err.message);
        db.rollback(() =>
          res.status(500).json({ error: "Failed to delete package and associated data", details: err.message })
        );
      }
    });
  } catch (e) {
    console.error("Error switching DB for /deletepackage:", e.msg || e.message, e.err || '');
    return res.status(e.status || 500).json({ error: e.msg || "DB switch failed" });
  }
});


// SubBox -------------------------------------------------------------------------------------------------------------------
// Refactored to use async/await and q helper
app.get("/remainboxitem", async (req, res) => {
  const { box_id, emp_id } = req.query;
  if (!box_id) {
    return res.status(400).json({ error: "box_id is required." });
  }
  const query =
    `SELECT bi.*, 
            bi.quantity - COALESCE(SUM(sbi.sub_quantity), 0) AS remaining_quantity, 
            CASE 
                WHEN bi.quantity = 0 THEN 0  -- Avoid division by zero
                ELSE bi.weight * (bi.quantity - COALESCE(SUM(sbi.sub_quantity), 0)) / bi.quantity 
            END AS adjusted_weight 
     FROM items bi 
     LEFT JOIN subbox sb ON bi.box_id = sb.box_id 
     LEFT JOIN subbox_item sbi ON sb.subbox_id = sbi.subbox_id AND bi.item_id = sbi.item_id 
     WHERE bi.box_id = ? 
     GROUP BY bi.item_id, bi.quantity, bi.weight /* Added all non-aggregated columns from SELECT to GROUP BY */
     HAVING remaining_quantity != 0;`;
  try {
    await switchToEmployeeDB(emp_id);
    const results = await q(query, [box_id]);
    res.json(results);
  } catch (e) {
    console.error("Error in /remainboxitem:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to fetch remaining box items." });
  }
});

app.get("/itemsubbox", async (req, res) => {
  const { subbox_id, emp_id } = req.query;
  if (!subbox_id) {
    return res.status(400).json({ error: "subbox_id is required." });
  }
  const query =
    `SELECT sbi.*, i.item_name, i.item_type, i.item_subtype, i.packer_id, i.photo_url, i.box_id, i.item_status, i.Date_create,
            CASE 
                WHEN i.quantity = 0 THEN 0 
                ELSE i.weight * sbi.sub_quantity / i.quantity 
            END AS adjusted_weight 
     FROM subbox_item sbi 
     LEFT JOIN items i ON sbi.item_id = i.item_id 
     WHERE sbi.subbox_id = ?;`;
  try {
    await switchToEmployeeDB(emp_id);
    const results = await q(query, [subbox_id]);
    res.json(results);
  } catch (e) {
    console.error("Error in /itemsubbox:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to fetch item subbox details." });
  }
});

app.post("/edititemsubbox", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { subbox_id, items, emp_id } = req.body;

  if (!subbox_id || typeof items !== 'object' || items === null || Array.isArray(items)) {
    return res.status(400).json({ error: "subbox_id and items (as an object) are required." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    const updateQuery = "UPDATE `subbox_item` SET `sub_quantity` = ? WHERE `subbox_id` = ? AND `item_id` = ?;";
    const deleteQuery = "DELETE FROM `subbox_item` WHERE `subbox_id` = ? AND `item_id` = ?;";
    
    const promises = Object.entries(items).map(async ([item_id, sub_quantity_val]) => {
      const sub_quantity = Number(sub_quantity_val);
      if (isNaN(sub_quantity)) {
          throw new Error(`Invalid sub_quantity for item_id ${item_id}: ${sub_quantity_val}`);
      }
      if (sub_quantity === 0) {
        await q(deleteQuery, [subbox_id, item_id]);
        return { action: "deleted", item_id };
      } else {
        await q(updateQuery, [sub_quantity, subbox_id, item_id]);
        return { action: "updated", item_id, sub_quantity };
      }
    });

    const results = await Promise.all(promises);
    res.json({ message: "All items updated successfully", results });
  } catch (e) {
    console.error("Error in /edititemsubbox:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to update subbox items." });
  }
});

app.get("/subboxinfo", async (req, res) => {
  const { subbox_id, emp_id } = req.query;
  if (!subbox_id) {
    return res.status(400).json({ error: "subbox_id is required." });
  }
  const query = "SELECT * FROM `subbox` WHERE `subbox_id` = ?;";
  try {
    await switchToEmployeeDB(emp_id);
    const results = await q(query, [subbox_id]);
    if (results.length === 0) {
        return res.status(404).json({ error: "Subbox info not found." });
    }
    res.json(results[0]); // Send single object
  } catch (e) {
    console.error("Error in /subboxinfo:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to fetch subbox info." });
  }
});

app.post("/addsubbox", async (req, res) => {
    if (!req.body) return res.status(400).json({ error: "Request body is missing" });
    const { box_id, weight, width, b_long, height, img_url, items, emp_id } = req.body;

    if (!box_id || !Array.isArray(items)) {
        return res.status(400).json({ error: "box_id and items array are required." });
    }
    // Add more validation for numeric fields if necessary

    try {
        await switchToEmployeeDB(emp_id);
        const query1 = "INSERT INTO `subbox` (`box_id`, `weight`, `width`, `b_long`, `height`, `img_url`) VALUES (?, ?, ?, ?, ?, ?);";
        const result1 = await q(query1, [box_id, Number(weight) || 0, Number(width) || 0, Number(b_long) || 0, Number(height) || 0, img_url || null]);
        const subboxId = result1.insertId;

        if (items.length > 0) {
            const values = items.map(item => {
                if (!item || item.item_id === undefined) throw new Error("Invalid item structure in items array.");
                const quantity = Number(item.selectedQuantity);
                const remaining = Number(item.remaining_quantity);
                return [
                    subboxId,
                    item.item_id,
                    quantity === 0 ? remaining : quantity
                ];
            });
            const query2 = "INSERT INTO `subbox_item` (`subbox_id`, `item_id`, `sub_quantity`) VALUES ?;";
            await q(query2, [values]);
        }
        res.json({ message: "Subbox and items added successfully", subboxId });
    } catch (e) {
        console.error("Error in /addsubbox:", e.msg || e.message, e.err || '');
        res.status(e.status || 500).json({ error: e.msg || "Failed to add subbox." });
    }
});

app.post("/editsubbox", async (req, res) => {
    if (!req.body) return res.status(400).json({ error: "Request body is missing" });
    const { subbox_id, weight, width, b_long, height, img_url, emp_id } = req.body;

    if (!subbox_id) {
        return res.status(400).json({ error: "subbox_id is required." });
    }

    try {
        await switchToEmployeeDB(emp_id);
        const query1 = "UPDATE `subbox` SET `weight` = ?, `width` = ?, `b_long` = ?, `height` = ?, `img_url` = ? WHERE `subbox_id` = ?;";
        await q(query1, [Number(weight) || 0, Number(width) || 0, Number(b_long) || 0, Number(height) || 0, img_url || null, subbox_id]);
        res.json({ message: "Subbox edited successfully." });
    } catch (e) {
        console.error("Error in /editsubbox:", e.msg || e.message, e.err || '');
        res.status(e.status || 500).json({ error: e.msg || "Failed to edit subbox." });
    }
});

app.post("/editsubbox_track", async (req, res) => {
    if (!req.body) return res.status(400).json({ error: "Request body is missing" });
    const { subbox_id: subboxIds, subbox_tracking, subbox_cost, emp_id } = req.body; // Renamed subbox_id to subboxIds for clarity

    if (!Array.isArray(subboxIds) || !Array.isArray(subbox_tracking) || !Array.isArray(subbox_cost)) {
        return res.status(400).json({ error: "subbox_id, subbox_tracking, and subbox_cost must be arrays." });
    }
    if (subboxIds.length !== subbox_tracking.length || subboxIds.length !== subbox_cost.length) {
        return res.status(400).json({ error: "Input arrays must have the same length." });
    }

    try {
        await switchToEmployeeDB(emp_id);
        const query1 = "UPDATE `subbox` SET `subbox_tracking` = ?, `subbox_cost` = ? WHERE `subbox_id` = ?";
        
        const updates = subboxIds.map((idObj, index) => {
            // Assuming idObj is like { subbox_id: value } from original console.log
            const currentSubboxId = idObj && idObj.subbox_id !== undefined ? idObj.subbox_id : idObj; 
            if (currentSubboxId === undefined || currentSubboxId === null) {
                throw new Error(`Invalid subbox_id at index ${index}`);
            }
            return q(query1, [subbox_tracking[index] || null, Number(subbox_cost[index]) || 0, currentSubboxId]);
        });

        await Promise.all(updates);
        res.json({ message: "All subbox tracking info edited successfully." });
    } catch (e) {
        console.error("Error in /editsubbox_track:", e.msg || e.message, e.err || '');
        res.status(e.status || 500).json({ error: e.msg || "Failed to update subbox tracking info." });
    }
});

app.post("/deletesubbox", async (req, res) => {
    if (!req.body) return res.status(400).json({ error: "Request body is missing" });
    const { subbox_id, emp_id } = req.body;

    if (!subbox_id) {
        return res.status(400).json({ error: "subbox_id is required." });
    }

    try {
        await switchToEmployeeDB(emp_id);
        db.beginTransaction(async (txErr) => {
            if (txErr) {
                console.error("Transaction start error in /deletesubbox:", txErr.message);
                return res.status(500).json({ error: "Transaction error", details: txErr.message });
            }
            try {
                await q("DELETE FROM subbox_item WHERE `subbox_id` = ?;", [subbox_id]);
                const subboxDeleteResult = await q("DELETE FROM subbox WHERE `subbox_id` = ?;", [subbox_id]);

                if (subboxDeleteResult.affectedRows === 0) {
                     console.warn(`Subbox with id ${subbox_id} not found for deletion or already deleted. Still committing item deletions.`);
                }

                db.commit((commitErr) => {
                    if (commitErr) {
                        console.error("Commit error in /deletesubbox:", commitErr.message);
                        return db.rollback(() => res.status(500).json({ error: "Commit failed", details: commitErr.message }));
                    }
                    res.json({ success: true, message: "Subbox and associated items deleted successfully" });
                });
            } catch (err) {
                console.error("Error during /deletesubbox transaction:", err.message);
                db.rollback(() => res.status(500).json({ error: "Failed to delete subbox", details: err.message }));
            }
        });
    } catch (e) {
        console.error("Error switching DB for /deletesubbox:", e.msg || e.message, e.err || '');
        return res.status(e.status || 500).json({ error: e.msg || "DB switch failed" });
    }
});

app.post("/addsubboxitem", async (req, res) => {
    if (!req.body) return res.status(400).json({ error: "Request body is missing" });
    const { items, subbox_id, emp_id } = req.body;

    if (!subbox_id || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "subbox_id and a non-empty items array are required." });
    }
    
    try {
        await switchToEmployeeDB(emp_id);
        const values = items.map(item => {
            if (!item || item.item_id === undefined || item.quantity === undefined || item.remaining_quantity === undefined) {
                throw new Error("Invalid item structure in items array. Each item needs item_id, quantity, and remaining_quantity.");
            }
            const quantity = Number(item.quantity);
            const remaining = Number(item.remaining_quantity);
            return [
                subbox_id,
                item.item_id,
                quantity === 0 ? remaining : quantity,
            ];
        });

        // ON DUPLICATE KEY UPDATE is MySQL specific.
        const query = "INSERT INTO subbox_item (subbox_id, item_id, sub_quantity) VALUES ? ON DUPLICATE KEY UPDATE sub_quantity = sub_quantity + VALUES(sub_quantity);";
        await q(query, [values]);
        res.json({ message: "Subbox items added/updated successfully." });
    } catch (e) {
        console.error("Error in /addsubboxitem:", e.msg || e.message, e.err || '');
        res.status(e.status || 500).json({ error: e.msg || "Failed to add/update subbox items." });
    }
});


// Box -------------------------------------------------------------------------------------------------------------------
// These routes are more complex and involve multiple queries or specific logic.
// They have been refactored to use async/await and include more robust error handling and input validation.

app.get("/box", async (req, res) => {
  const { box_id, emp_id } = req.query;
  if (!box_id) {
    return res.status(400).json({ error: "box_id is required." });
  }
  try {
    await switchToEmployeeDB(emp_id);
    const results = await q("SELECT * FROM box WHERE box_id = ?;", [box_id]);
    if (results.length === 0) {
      return res.status(404).json({ error: "Box not found." });
    }
    res.json(results[0]); // Send single object
  } catch (e) {
    console.error("Error in /box:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to fetch box details." });
  }
});

app.post("/addbox", async (req, res) => {
  if (!req.body || !req.body.submissionData) {
    return res.status(400).json({ error: "Request body with submissionData is missing." });
  }
  const { sender, recipients, note, packages } = req.body.submissionData;
  const { emp_id } = req.body; // emp_id for DB switch

  if (!sender || !recipients || !Array.isArray(packages)) {
    return res.status(400).json({ error: "Missing required fields in submissionData: sender, recipients, or packages array." });
  }

  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const time = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`; // HHMMSS for uniqueness
  const box_id = `${sender}_${date}T${time}`;

  try {
    await switchToEmployeeDB(emp_id);
    db.beginTransaction(async (txErr) => {
      if (txErr) {
        console.error("Transaction start error in /addbox:", txErr.message);
        return res.status(500).json({ error: "Transaction error", details: txErr.message });
      }
      try {
        await q("INSERT INTO `box` (`box_id`, `customer_id`, `address_id`, `note`) VALUES (?, ?, ?, ?)", 
                [box_id, sender, recipients, note || null]);

        const itemUpdatePromises = [];
        packages.forEach((pkg) => {
          if (pkg && Array.isArray(pkg.items)) {
            pkg.items.forEach((item) => {
              if (item && item.item_id !== undefined) {
                itemUpdatePromises.push(
                  q("UPDATE `items` SET `box_id` = ?, `item_status` = 1 WHERE `item_id` = ?", [box_id, item.item_id])
                );
              }
            });
          }
        });
        await Promise.all(itemUpdatePromises);
        await q("UPDATE `customers` SET `packages` = `packages` + 1 WHERE `customer_id` = ?", [sender]);

        db.commit((commitErr) => {
          if (commitErr) {
            console.error("Commit error in /addbox:", commitErr.message);
            return db.rollback(() => res.status(500).json({ error: "Commit failed", details: commitErr.message }));
          }
          res.json({ message: "Box and items added successfully", boxId: box_id });
        });
      } catch (err) {
        console.error("Error during /addbox transaction:", err.message);
        db.rollback(() => res.status(500).json({ error: "Failed to add box", details: err.message }));
      }
    });
  } catch (e) {
    console.error("Error switching DB for /addbox:", e.msg || e.message, e.err || '');
    return res.status(e.status || 500).json({ error: e.msg || "DB switch failed" });
  }
});

app.post("/deletebox", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { customer_id, box_id, emp_id } = req.body;

  if (!box_id) {
    return res.status(400).json({ error: "box_id is required." });
  }
  if (!customer_id) { // customer_id needed for status update logic
    return res.status(400).json({ error: "customer_id is required for status update logic." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    db.beginTransaction(async (txErr) => {
      if (txErr) {
        console.error("Transaction start error in /deletebox:", txErr.message);
        return res.status(500).json({ error: "Transaction error", details: txErr.message });
      }
      try {
        await q("UPDATE items SET item_status = 0, box_id = NULL WHERE box_id = ?;", [box_id]);
        await q("DELETE FROM subbox_item WHERE subbox_id IN (SELECT subbox_id FROM subbox WHERE box_id = ?)", [box_id]);
        await q("DELETE FROM subbox WHERE box_id = ?", [box_id]);
        const boxDeleteResult = await q("DELETE FROM box WHERE box_id = ?", [box_id]);

        if (boxDeleteResult.affectedRows > 0) { // Only update customer if box was actually deleted
            const updateCustomerStatusSQL = `
                UPDATE customers 
                SET packages = GREATEST(0, packages - 1), /* Ensure packages don't go negative */
                    status = CASE 
                                WHEN EXISTS (SELECT 1 FROM box WHERE customer_id = ? AND box_status = 'Packed') THEN 'Unpaid' /* If other boxes are packed */
                                WHEN EXISTS (SELECT 1 FROM items i JOIN packages p ON i.tracking_number = p.tracking_number WHERE p.customer_id = ? AND i.item_status = 0) THEN 'Warehouse'
                                ELSE NULL
                             END 
                WHERE customer_id = ?`;
            await q(updateCustomerStatusSQL, [customer_id, customer_id, customer_id]);
        } else {
            console.warn(`Box with ID ${box_id} not found for deletion. Customer status not updated.`);
        }

        db.commit((commitErr) => {
          if (commitErr) {
            console.error("Commit error in /deletebox:", commitErr.message);
            return db.rollback(() => res.status(500).json({ error: "Commit failed", details: commitErr.message }));
          }
          res.json({ message: "Box deleted and statuses updated successfully", box_id });
        });
      } catch (err) {
        console.error("Error during /deletebox transaction:", err.message);
        db.rollback(() => res.status(500).json({ error: "Failed to delete box", details: err.message }));
      }
    });
  } catch (e) {
    console.error("Error switching DB for /deletebox:", e.msg || e.message, e.err || '');
    return res.status(e.status || 500).json({ error: e.msg || "DB switch failed" });
  }
});


app.get("/boxitem", async (req, res) => {
  const { box_id, emp_id } = req.query;
  if (!box_id) {
    return res.status(400).json({ error: "box_id is required." });
  }
  try {
    await switchToEmployeeDB(emp_id);
    const results = await q("SELECT * FROM items WHERE box_id = ?;", [box_id]);
    res.json(results); // OK to return empty array if no items
  } catch (e) {
    console.error("Error in /boxitem:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to fetch box items." });
  }
});

app.get("/boxslip", async (req, res) => {
  const { box_id, emp_id } = req.query;
  if (!box_id) {
    return res.status(400).json({ error: "box_id is required." });
  }
  try {
    await switchToEmployeeDB(emp_id);
    const results = await q("SELECT * FROM slip WHERE box_id = ?;", [box_id]);
    res.json(results); // OK to return empty array
  } catch (e) {
    console.error("Error in /boxslip:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to fetch box slips." });
  }
});

app.get("/subbox", async (req, res) => {
  const { box_id, emp_id } = req.query;
  if (!box_id) {
    return res.status(400).json({ error: "box_id is required." });
  }
  try {
    await switchToEmployeeDB(emp_id);
    const querySubbox =
      `SELECT sb.*, 
              ROUND(GREATEST(sb.weight, (sb.width * sb.b_long * sb.height) / 5000), 2) AS volumetricWeight 
       FROM subbox sb WHERE sb.box_id = ?;`;
    const subboxes = await q(querySubbox, [box_id]);

    if (subboxes.length === 0) {
      return res.json([]);
    }

    const subboxIds = subboxes.map((sub) => sub.subbox_id);
    const querySubboxItem =
      `SELECT sbi.*, i.item_name, i.item_type, i.photo_url,
              CASE 
                  WHEN i.quantity = 0 THEN 0 
                  ELSE i.weight * sbi.sub_quantity / i.quantity 
              END AS adjusted_weight 
       FROM subbox_item sbi 
       LEFT JOIN items AS i ON sbi.item_id = i.item_id 
       WHERE sbi.subbox_id IN (?);`;
    const subboxItems = await q(querySubboxItem, [subboxIds]);

    const subboxMap = subboxes.reduce((acc, sb) => {
      acc[sb.subbox_id] = { ...sb, items: [] };
      return acc;
    }, {});

    subboxItems.forEach((item) => {
      if (subboxMap[item.subbox_id]) {
        subboxMap[item.subbox_id].items.push(item);
      }
    });

    res.json(Object.values(subboxMap));
  } catch (e) {
    console.error("Error in /subbox:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to fetch subbox details." });
  }
});

app.get("/subbox_box", async (req, res) => {
  const { box_id, emp_id } = req.query;
  if (!box_id) {
    return res.status(400).json({ error: "box_id is required." });
  }
  try {
    await switchToEmployeeDB(emp_id);
    const subboxes = await q("SELECT * FROM subbox WHERE box_id = ?;", [box_id]);
    res.json(subboxes);
  } catch (e) {
    console.error("Error in /subbox_box:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to fetch subboxes for box." });
  }
});

app.post("/createslip", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { slip: slip_img, amount, details, BoxId: box_id, emp_id } = req.body; // Renamed for clarity

  if (!box_id || slip_img === undefined || amount === undefined) {
    return res.status(400).json({ error: "BoxId, slip image URL, and amount are required." });
  }
  try {
    await switchToEmployeeDB(emp_id);
    const result = await q(
      "INSERT INTO `slip` (`box_id`, `slip_img`, `price`, `details`) VALUES (?, ?, ?, ?);",
      [box_id, slip_img, Number(amount) || 0, details || null]
    );
    res.json({ message: "Slip created successfully.", slipId: result.insertId });
  } catch (e) {
    console.error("Error in /createslip:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to create slip." });
  }
});

app.post("/deleteslip", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { slip: slip_id, emp_id } = req.body; // Assuming 'slip' from body is slip_id

  if (!slip_id) {
    return res.status(400).json({ error: "slip_id is required." });
  }
  try {
    await switchToEmployeeDB(emp_id);
    const result = await q("DELETE FROM slip WHERE `slip_id` = ?;", [slip_id]);
    if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Slip not found or already deleted." });
    }
    res.json({ message: "Slip deleted successfully." });
  } catch (e) {
    console.error("Error in /deleteslip:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to delete slip." });
  }
});

// packages & completed-------------------------------------------------------------------------------------------------------------------
app.get("/box1", async (req, res) => { // For "Ordered", "Process", "Packed"
  const { emp_id } = req.query;
  try {
    await switchToEmployeeDB(emp_id);
    const [orderedResults, processResults, packedResults] = await Promise.all([
      q("SELECT * FROM box WHERE box_status = 'Ordered' ORDER BY `priority` ASC, `box_id` DESC;"), // Added secondary sort
      q("SELECT * FROM box WHERE box_status = 'Process' ORDER BY `priority` ASC, `box_id` DESC;"),
      q("SELECT * FROM box WHERE box_status = 'Packed' ORDER BY `priority` ASC, `box_id` DESC;")
    ]);
    res.json({
      Ordered: orderedResults,
      Process: processResults,
      Packed: packedResults,
    });
  } catch (e) {
    console.error("Error in /box1:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to fetch box data (stage 1)." });
  }
});

app.get("/box2", async (req, res) => { // For "Paid", "Documented"
  const { emp_id } = req.query;
  try {
    await switchToEmployeeDB(emp_id);
    const [paidResults, documentedResults] = await Promise.all([
      q("SELECT * FROM box WHERE box_status = 'Paid' ORDER BY `priority` ASC, `box_id` DESC;"),
      q("SELECT * FROM box WHERE box_status = 'Documented' ORDER BY `priority` ASC, `box_id` DESC;")
    ]);
    res.json({
      Paid: paidResults,
      Documented: documentedResults,
    });
  } catch (e) {
    console.error("Error in /box2:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to fetch box data (stage 2)." });
  }
});

app.post("/editbox", async (req, res) => {
    if (!req.body) return res.status(400).json({ error: "Request body is missing" });
    const { box_id, box_status, bprice, customer_id, document, discount, emp_id } = req.body;

    if (!box_id) return res.status(400).json({ error: "box_id is required." });

    try {
        await switchToEmployeeDB(emp_id);
        let mainQuerySql, mainQueryParams;
        let customerStatusUpdateNeeded = false;
        let newCustomerStatus = null; // 'Unpaid', 'Warehouse', or NULL

        if (bprice !== undefined) { // Case: Updating status, price, document (typically moving to Packed)
            if (!box_status || !customer_id) return res.status(400).json({ error: "box_status and customer_id are required when bprice is set."});
            mainQuerySql = "UPDATE `box` SET `box_status` = ?, `bprice` = ?, `document` = ? WHERE `box_id` = ?;";
            mainQueryParams = [box_status, Number(bprice) || 0, document || null, box_id];
            if (box_status === "Packed") {
                customerStatusUpdateNeeded = true;
                newCustomerStatus = 'Unpaid';
            } else { // If not "Packed" but bprice is set (unusual), revert to Warehouse/NULL logic
                customerStatusUpdateNeeded = true; 
                // newCustomerStatus will be determined by item check below
            }
        } else if (discount !== undefined) { // Case: Updating discount only
            mainQuerySql = "UPDATE `box` SET `discount` = ? WHERE `box_id` = ?;";
            mainQueryParams = [Number(discount) || 0, box_id];
        } else if (box_status !== undefined && customer_id !== undefined) { // Case: Updating status with customer_id (typically Paid -> Warehouse/NULL or revert from Packed)
            mainQuerySql = "UPDATE `box` SET `box_status` = ? WHERE `box_id` = ?;";
            mainQueryParams = [box_status, box_id];
            customerStatusUpdateNeeded = true;
            if (box_status === "Paid") {
                // newCustomerStatus will be determined by item check below
            } else { // e.g. moving from Packed back to Process, customer should become Unpaid if other Packed boxes exist
                 // This logic is complex, current implementation sets to Unpaid
                 newCustomerStatus = 'Unpaid'; // Simplified assumption, may need refinement
            }
        } else if (box_status !== undefined) { // Case: Updating status only (no customer context)
            mainQuerySql = "UPDATE `box` SET `box_status` = ? WHERE `box_id` = ?;";
            mainQueryParams = [box_status, box_id];
        } else {
            return res.status(400).json({ error: "No valid parameters provided for editbox." });
        }

        await q(mainQuerySql, mainQueryParams);

        if (customerStatusUpdateNeeded && customer_id) {
            if (newCustomerStatus === 'Unpaid') {
                 await q("UPDATE customers SET status = 'Unpaid' WHERE customer_id = ?;", [customer_id]);
            } else { // Determine Warehouse or NULL status
                const [{ count }] = await q(
                    `SELECT COUNT(*) AS count FROM items i 
                     JOIN packages p ON i.tracking_number = p.tracking_number 
                     WHERE p.customer_id = ? AND i.item_status = 0`,
                    [customer_id]
                );
                const finalStatus = count > 0 ? 'Warehouse' : null;
                await q("UPDATE customers SET status = ? WHERE customer_id = ? AND status != 'Unpaid'", [finalStatus, customer_id]);
            }
        }
        res.json({ message: "Box edited and customer status updated successfully." });
    } catch (e) {
        console.error("Error in /editbox:", e.msg || e.message, e.err || '');
        res.status(e.status || 500).json({ error: e.msg || "Failed to edit box." });
    }
});


app.post("/editpriority", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { box_id, priority, emp_id } = req.body;

  if (!box_id || priority === undefined) {
    return res.status(400).json({ error: "box_id and priority are required." });
  }
  try {
    await switchToEmployeeDB(emp_id);
    await q("UPDATE `box` SET `priority` = ? WHERE `box_id` = ?;", [Number(priority) || 0, box_id]);
    res.json({ message: "Box priority edited successfully." });
  } catch (e) {
    console.error("Error in /editpriority:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to edit box priority." });
  }
});

// appointment-------------------------------------------------------------------------------------------------------------------
app.get("/appointment", async (req, res) => {
  const { emp_id } = req.query;
  // status = 'Pending' AND start_date > CURDATE() - INTERVAL 1 DAY
  // This query selects appointments that are pending and whose start_date is today or in the future.
  const query =
    "SELECT *, DATE_FORMAT(start_date, '%Y-%m-%d') AS formatted_start_date, TIME_FORMAT(start_date, '%H:%i') AS formatted_start_time FROM appointment WHERE status = 'Pending' AND start_date >= CURDATE() ORDER BY start_date ASC;";
  try {
    await switchToEmployeeDB(emp_id);
    const results = await q(query);
    res.json(results);
  } catch (e) {
    console.error("Error in /appointment:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to fetch appointments." });
  }
});

app.post("/addappoint", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const {
    title, address_pickup, phone_pickup, name_pickup, position, vehicle, note,
    pickupdate, pickupTime, emp_id // pickupTime should be HH:MM
  } = req.body;

  if (!title || !pickupdate || !pickupTime) {
    return res.status(400).json({ error: "Title, pickupdate, and pickupTime are required." });
  }

  const dateTimeString = `${pickupdate}T${pickupTime}:00`; // Assuming local time
  const startDateTime = new Date(dateTimeString);
  if (isNaN(startDateTime.getTime())) {
    return res.status(400).json({ error: "Invalid pickupdate or pickupTime format. Use YYYY-MM-DD and HH:MM." });
  }
  
  // MySQL expects 'YYYY-MM-DD HH:MM:SS'
  const formatForMySQL = (dateObj) => {
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    const hours = String(dateObj.getHours()).padStart(2, '0');
    const minutes = String(dateObj.getMinutes()).padStart(2, '0');
    const seconds = String(dateObj.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  };

  const start_time_mysql = formatForMySQL(startDateTime);
  const endDateTime = new Date(startDateTime.getTime() + 30 * 60000); // Add 30 minutes
  const end_time_mysql = formatForMySQL(endDateTime);

  const query1 =
    "INSERT INTO `appointment` (`title`, `start_date`, `end_date`, `note`, `customer_id`, `address_pickup`, `phone_pickup`, `name_pickup`, `position`, `vehicle`, `status`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending');";
  try {
    await switchToEmployeeDB(emp_id);
    const result = await q(query1, [
      title, start_time_mysql, end_time_mysql, note || null, title, // Assuming title is customer_id
      address_pickup || null, phone_pickup || null, name_pickup || null, position || null, vehicle || null
    ]);
    res.json({ message: "Appointment added successfully.", appointId: result.insertId });
  } catch (e) {
    console.error("Error in /addappoint:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to add appointment." });
  }
});

app.post("/editappoint", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const {
    appoint_id: address_id, // appoint_id is expected from frontend as 'address_id'
    address_pickup, phone_pickup, name_pickup, position, vehicle, note, status, // Added status
    pickupdate, pickupTime, // For editing time
    emp_id
  } = req.body;

  if (!address_id) {
    return res.status(400).json({ error: "appoint_id (as address_id) is required." });
  }
  
  let start_time_mysql, end_time_mysql;
  if (pickupdate && pickupTime) {
    const dateTimeString = `${pickupdate}T${pickupTime}:00`;
    const startDateTime = new Date(dateTimeString);
    if (isNaN(startDateTime.getTime())) {
        return res.status(400).json({ error: "Invalid pickupdate or pickupTime format for editing." });
    }
    const formatForMySQL = (dateObj) => `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')} ${String(dateObj.getHours()).padStart(2, '0')}:${String(dateObj.getMinutes()).padStart(2, '0')}:${String(dateObj.getSeconds()).padStart(2, '0')}`;
    start_time_mysql = formatForMySQL(startDateTime);
    const endDateTime = new Date(startDateTime.getTime() + 30 * 60000);
    end_time_mysql = formatForMySQL(endDateTime);
  }


  // Build query dynamically based on provided fields
  const updates = [];
  const params = [];
  if (note !== undefined) { updates.push("`note` = ?"); params.push(note); }
  if (address_pickup !== undefined) { updates.push("`address_pickup` = ?"); params.push(address_pickup); }
  if (phone_pickup !== undefined) { updates.push("`phone_pickup` = ?"); params.push(phone_pickup); }
  if (name_pickup !== undefined) { updates.push("`name_pickup` = ?"); params.push(name_pickup); }
  if (position !== undefined) { updates.push("`position` = ?"); params.push(position); }
  if (vehicle !== undefined) { updates.push("`vehicle` = ?"); params.push(vehicle); }
  if (status !== undefined) { updates.push("`status` = ?"); params.push(status); }
  if (start_time_mysql !== undefined) { updates.push("`start_date` = ?"); params.push(start_time_mysql); }
  if (end_time_mysql !== undefined) { updates.push("`end_date` = ?"); params.push(end_time_mysql); }


  if (updates.length === 0) {
    return res.status(400).json({ error: "No fields provided for update." });
  }

  params.push(address_id); // For WHERE clause
  const query1 = `UPDATE appointment SET ${updates.join(", ")} WHERE appoint_id = ?;`;

  try {
    await switchToEmployeeDB(emp_id);
    await q(query1, params);
    res.json({ message: "Appointment edited successfully." });
  } catch (e) {
    console.error("Error in /editappoint:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to edit appointment." });
  }
});

// ThaiBox-------------------------------------------------------------------------------------------------------------------
app.get("/gentrack", async (req, res) => {
  const { type, emp_id } = req.query;
  if (!type) {
    return res.status(400).json({ error: "Tracking type prefix is required." });
  }
  const typelike = type + "-%"; // Ensure '-' for parsing number part
  // This query assumes tracking numbers are like PREFIX-NUMBER
  const query =
    "SELECT tracking_number FROM `packages` WHERE `tracking_number` LIKE ? ORDER BY CAST(SUBSTRING_INDEX(tracking_number, '-', -1) AS UNSIGNED) DESC LIMIT 1;";
  try {
    await switchToEmployeeDB(emp_id);
    const results = await q(query, [typelike]);
    res.json(results); // Returns array, potentially empty
  } catch (e) {
    console.error("Error in /gentrack:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Failed to generate tracking number." });
  }
});

// User-------------------------------------------------------------------------------------------------------------------
app.post("/editsendaddr", async (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const {
    customer_id, customer_name, address, city, state,
    country = "Thailand", // Default value
    zipcode, phone, doc_type, doc_url, emp_id,
  } = req.body;

  if (!emp_id) return res.status(400).json({ error: "emp_id is required" });
  if (!customer_id) return res.status(400).json({ error: "customer_id is required" });
  // Add more validation for other fields if they are mandatory

  try {
    await switchToEmployeeDB(emp_id);
    let sql =
      "UPDATE customers SET customer_name = ?, address = ?, city = ?, state = ?, country = ?, zipcode = ?, phone = ?";
    const params = [
      customer_name || null, address || null, city || null, state || null, country,
      zipcode || null, phone || null
    ];

    if (doc_type !== undefined && doc_url !== undefined) {
      sql += ", doc_type = ?, doc_url = ?";
      params.push(doc_type, doc_url);
    }
    sql += " WHERE customer_id = ?";
    params.push(customer_id);

    await q(sql, params);
    return res.json({ success: true, message: "Customer address updated successfully." });
  } catch (e) {
    console.error("Error in /editsendaddr:", e.msg || e.message, e.err || '');
    return res.status(e.status || 500).json({ error: e.msg || "Internal server error while updating address" });
  }
});

// Setting-------------------------------------------------------------------------------------------------------------------
// Routes related to FS operations for settings need robust path handling and error checking.
// Ensure RAILWAY_VOLUME_MOUNT_PATH is correctly set.

const getCompanyFilePath = (companyName, fileName) => {
  if (!process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    console.error("RAILWAY_VOLUME_MOUNT_PATH is not set.");
    throw new Error("Server configuration error: Volume mount path missing.");
  }
  if (!companyName || typeof companyName !== 'string' || companyName.trim() === '') {
    throw new Error("Invalid company name for file path generation.");
  }
  const dirPath = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, companyName.trim());
  const filePath = path.join(dirPath, fileName);
  return { dirPath, filePath };
};

const readOrCreateJsonFile = (filePath, dirPath, defaultData = {}) => {
  try {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data);
  } catch (fsErr) {
    console.error(`Filesystem error for ${filePath}:`, fsErr.message);
    throw new Error(`Failed to load or create ${path.basename(filePath)} information`);
  }
};

const writeJsonFile = (filePath, dirPath, data) => {
  try {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (fsErr) {
    console.error(`Filesystem error writing to ${filePath}:`, fsErr.message);
    throw new Error(`Failed to save ${path.basename(filePath)} information`);
  }
};

app.get("/company_info", (req, res) => {
  const { emp_id } = req.query;
  if (!emp_id) return res.status(400).json({ error: "emp_id is required" });

  companydb.query("SELECT company_name FROM employee WHERE emp_id = ?", [emp_id], (err, results) => {
    if (err) {
      console.error("DB error in /company_info:", err.message);
      return res.status(500).json({ error: "Database error" });
    }
    const row = firstRowOr404(res, results, "Employee not found for company_info.");
    if (!row) return;
    if (!row.company_name) return res.status(500).json({error: "Company name not found for employee."});


    try {
      const { dirPath, filePath } = getCompanyFilePath(row.company_name, "company_info.json");
      const data = readOrCreateJsonFile(filePath, dirPath, {});
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

app.get("/dropdown", (req, res) => {
  const { emp_id } = req.query;
  if (!emp_id) return res.status(400).json({ error: "emp_id is required" });
  const emptyData = { channels: [], categories: [], levels: [] };

  companydb.query("SELECT company_name FROM employee WHERE emp_id = ?", [emp_id], (err, results) => {
    if (err) {
      console.error("DB error in /dropdown:", err.message);
      return res.status(500).json({ error: "Failed to fetch employee data" });
    }
    const row = firstRowOr404(res, results, "Employee not found for dropdown settings.");
    if (!row) return;
    if (!row.company_name) return res.status(500).json({error: "Company name not found for employee."});

    try {
      const { dirPath, filePath } = getCompanyFilePath(row.company_name, "dropdown.json");
      const data = readOrCreateJsonFile(filePath, dirPath, emptyData);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

app.post("/editdropdown", (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { channels, categories, levels, emp_id } = req.body; // Assuming newData structure

  if (!emp_id || !Array.isArray(channels) || !Array.isArray(categories) || !Array.isArray(levels)) {
    return res.status(400).json({ error: "emp_id and arrays for channels, categories, levels are required." });
  }
  // Sanitize: ensure names are strings and unique
  const sanitizeArray = (arr) => [...new Set(arr.filter(item => item && typeof item.name === 'string').map(item => item.name.trim()))];
  
  const processedData = {
    channels: sanitizeArray(channels),
    categories: sanitizeArray(categories),
    levels: sanitizeArray(levels),
  };

  companydb.query("SELECT company_name FROM employee WHERE emp_id = ?", [emp_id], (err, results) => {
    if (err) {
      console.error("DB error in /editdropdown:", err.message);
      return res.status(500).json({ error: "Failed to fetch employee data" });
    }
    const row = firstRowOr404(res, results, "Employee not found for dropdown settings update.");
    if (!row) return;
    if (!row.company_name) return res.status(500).json({error: "Company name not found for employee."});

    try {
      const { dirPath, filePath } = getCompanyFilePath(row.company_name, "dropdown.json");
      writeJsonFile(filePath, dirPath, processedData);
      res.json({ message: "Dropdown settings updated successfully." });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});


// Generic settings GET and POST handlers
const createSettingsRoute = (settingName, defaultData = {}) => {
    app.get(`/${settingName}`, (req, res) => {
        const { emp_id } = req.query;
        if (!emp_id) return res.status(400).json({ error: "emp_id is required" });

        companydb.query("SELECT company_name FROM employee WHERE emp_id = ?", [emp_id], (err, results) => {
            if (err) { console.error(`DB error in /${settingName}:`, err.message); return res.status(500).json({ error: "Database error" }); }
            const row = firstRowOr404(res, results, `Employee not found for ${settingName} settings.`);
            if (!row) return;
            if (!row.company_name) return res.status(500).json({error: `Company name not found for ${settingName}.`});

            try {
                const { dirPath, filePath } = getCompanyFilePath(row.company_name, `${settingName}.json`);
                const data = readOrCreateJsonFile(filePath, dirPath, defaultData);
                res.json(data);
            } catch (e) { res.status(500).json({ error: e.message }); }
        });
    });

    app.post(`/edit${settingName}`, (req, res) => { // data for edit should be in req.body.updatedData or similar
        if (!req.body) return res.status(400).json({ error: "Request body is missing" });
        const { emp_id } = req.body; // emp_id must be in the body
        const newData = req.body.updatedData || req.body.updatedPricing || req.body.updatedPromotions || req.body.formData || req.body; // Accommodate different body structures

        if (!emp_id || newData === undefined) return res.status(400).json({ error: `emp_id and data for ${settingName} are required.` });
        
        // Simple validation: newData should be an object
        if (typeof newData !== 'object' || newData === null) {
            return res.status(400).json({ error: `Data for ${settingName} must be an object.` });
        }


        companydb.query("SELECT company_name FROM employee WHERE emp_id = ?", [emp_id], (err, results) => {
            if (err) { console.error(`DB error in /edit${settingName}:`, err.message); return res.status(500).json({ error: "Database error" }); }
            const row = firstRowOr404(res, results, `Employee not found for ${settingName} settings update.`);
            if (!row) return;
            if (!row.company_name) return res.status(500).json({error: `Company name not found for ${settingName}.`});

            try {
                const { dirPath, filePath } = getCompanyFilePath(row.company_name, `${settingName}.json`);
                let dataToSave = newData;
                // Specific handling for /editwarehoussetting if 'emp_id' was part of data
                if (settingName === "warehouse" && newData.emp_id) {
                    const { emp_id: _, ...restOfData } = newData; // Remove emp_id from data being saved
                    dataToSave = restOfData;
                } else if (newData.updatedPricing) dataToSave = newData.updatedPricing; // for /editprice
                else if (newData.updatedPromotions) dataToSave = newData.updatedPromotions; // for /editpromotion
                else if (newData.formData) dataToSave = newData.formData; // for /editcompany_info

                writeJsonFile(filePath, dirPath, dataToSave);
                res.json({ message: `${settingName} settings updated successfully.` });
            } catch (e) { res.status(500).json({ error: e.message }); }
        });
    });
};

createSettingsRoute("price");
createSettingsRoute("promotion");
createSettingsRoute("warehouse"); // For /editwarehoussetting, data is req.body directly
createSettingsRoute("company_info"); // For /editcompany_info, data is req.body.formData


// Employee management uses companydb directly
app.get("/employee", (req, res) => {
  const { emp_id } = req.query; // This is the requesting employee's ID
  if (!emp_id) return res.status(400).json({ error: "Requesting emp_id is required." });

  companydb.query("SELECT company_name FROM `employee` WHERE `emp_id` = ?", [emp_id], (err, results) => {
    if (err) { console.error("DB error in /employee (step 1):", err.message); return res.status(500).json({ error: "Failed to fetch data" }); }
    const row = firstRowOr404(res, results, "Requesting employee not found.");
    if (!row) return;
    if (!row.company_name) return res.status(500).json({error: "Company name not found for requesting employee."});

    companydb.query("SELECT emp_id, username, emp_name, role, emp_date, eimg FROM `employee` WHERE `company_name` = ?", [row.company_name], (err, companyEmployees) => {
      if (err) { console.error("DB error in /employee (step 2):", err.message); return res.status(500).json({ error: "Failed to fetch company employees" }); }
      res.json(companyEmployees);
    });
  });
});

app.get("/employeeinfo", (req, res) => {
  const { id } = req.query; // Encrypted ID of the employee whose info is requested
  if (!id) return res.status(400).json({ error: "Encrypted employee ID (id) is required." });
  const decryptedId = decryptEmpId(id);
  if (!decryptedId) return res.status(400).json({ error: "Invalid or undecryptable employee ID."});

  companydb.query("SELECT emp_id, username, emp_name, role, emp_date, eimg FROM `employee` WHERE `emp_id` = ?;", [decryptedId], (err, results) => {
    if (err) { console.error("DB error in /employeeinfo:", err.message); return res.status(500).json({ error: "Failed to fetch data" }); }
    const row = firstRowOr404(res, results, "Employee info not found.");
    if (!row) return;
    res.json(row); // Send single employee object
  });
});

app.post("/addemployee", (req, res) => {
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { emp_name, username, role, password, emp_date, emp_id: requesting_emp_id } = req.body; // requesting_emp_id is of admin/owner

  if (!emp_name || !username || !role || !password || !requesting_emp_id) {
    return res.status(400).json({ error: "Missing required fields for adding employee." });
  }

  companydb.query("SELECT company_name, emp_database, emp_datapass FROM `employee` WHERE `emp_id` = ?", [requesting_emp_id], (err, results) => {
    if (err) { console.error("DB error in /addemployee (step 1):", err.message); return res.status(500).json({ error: "Failed to fetch requesting employee data" }); }
    const row = firstRowOr404(res, results, "Requesting employee not found.");
    if (!row) return;
    if (!row.company_name || !row.emp_database || !row.emp_datapass) {
        return res.status(500).json({error: "Configuration error: Requesting employee's company details missing."});
    }

    const query1 =
      "INSERT INTO `employee` (`username`, `emp_name`, `password`, `emp_database`, `emp_datapass`, `company_name`, `role`, `eimg`, `emp_date`) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?);";
    companydb.query(query1, [
        username, emp_name, password, // Consider hashing password
        row.emp_database, row.emp_datapass, row.company_name, role, emp_date || new Date()
      ], (err, insertResult) => {
      if (err) { console.error("DB error in /addemployee (step 2):", err.message); return res.status(500).json({ error: "Failed to add new employee" }); }
      res.json({ message: "Employee added successfully.", empId: insertResult.insertId });
    });
  });
});

app.post("/editemployee", (req, res) => { // Can be called by admin/owner
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { emp_id, emp_name, password, role, username } = req.body; // emp_id is the ID of employee to be edited

  if (!emp_id) return res.status(400).json({ error: "emp_id of employee to edit is required." });
  // Build dynamic query
  const updates = [];
  const params = [];
  if (username !== undefined) { updates.push("`username` = ?"); params.push(username); }
  if (emp_name !== undefined) { updates.push("`emp_name` = ?"); params.push(emp_name); }
  if (password !== undefined) { updates.push("`password` = ?"); params.push(password); } // Consider hashing
  if (role !== undefined) { updates.push("`role` = ?"); params.push(role); }

  if (updates.length === 0) return res.status(400).json({ error: "No fields provided for update." });
  
  params.push(emp_id);
  const query = `UPDATE employee SET ${updates.join(", ")} WHERE emp_id = ?;`;

  companydb.query(query, params, (err, results) => {
    if (err) { console.error("DB error in /editemployee:", err.message); return res.status(500).json({ error: "Failed to update employee" }); }
    if (results.affectedRows === 0) return res.status(404).json({error: "Employee not found or no changes made."});
    res.json({ message: "Employee updated successfully."});
  });
});

app.post("/deleteemployee", (req, res) => { // Can be called by admin/owner
  if (!req.body) return res.status(400).json({ error: "Request body is missing" });
  const { emp_id } = req.body; // emp_id of employee to be deleted

  if (!emp_id) return res.status(400).json({ error: "emp_id of employee to delete is required." });

  // Prevent owner from being deleted
  const query1 = "DELETE FROM `employee` WHERE `emp_id` = ? AND `role` != 'owner';";
  companydb.query(query1, [emp_id], (err, results) => {
    if (err) { console.error("DB error in /deleteemployee:", err.message); return res.status(500).json({ error: "Failed to delete employee" }); }
    if (results.affectedRows === 0) {
        return res.status(404).json({error: "Employee not found, or tried to delete owner, or already deleted."});
    }
    res.json({ message: "Employee deleted successfully." });
  });
});


//-------------------------------------------Local Management (Multer for local disk)------------------------------------------
// These routes are for local file storage, which might not be ideal for Railway (ephemeral storage).
// S3 uploads are generally preferred for cloud environments.
// Ensure RAILWAY_VOLUME_MOUNT_PATH is a persistent volume if local storage is truly needed.

const getLocalUploadPath = (subfolder) => {
    if (!process.env.RAILWAY_VOLUME_MOUNT_PATH) {
        console.error("RAILWAY_VOLUME_MOUNT_PATH is not set for local uploads.");
        return null; // Or throw error
    }
    const baseUploadDir = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "uploads");
    const targetDir = path.join(baseUploadDir, subfolder);
    if (!fs.existsSync(targetDir)) {
        try {
            fs.mkdirSync(targetDir, { recursive: true });
        } catch (e) {
            console.error(`Failed to create directory ${targetDir}:`, e.message);
            return null;
        }
    }
    return targetDir;
};

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = getLocalUploadPath("img");
    if (!uploadDir) return cb(new Error("Failed to get image upload directory."));
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Sanitize filename to prevent path traversal or invalid characters
    const safeOriginalName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, уникальныйСуффикс + '-' + safeOriginalName); // uniqueSuffix-originalName
  },
});
const uploadImage = multer({ 
    storage: imageStorage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'), false);
        }
    }
});

app.post("/uploadLogo", uploadImage.single("logo"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No file uploaded or invalid file type." });
  }
  // filePath will be just the filename, not the full server path for security.
  // Client reconstructs URL using base path + filename if needed for display.
  res.status(200).json({
    success: true,
    message: "Logo uploaded successfully",
    fileName: req.file.filename, // Send filename back
  });
});

app.post("/uploadSlip", uploadImage.single("slip"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No slip file uploaded or invalid file type." });
  }
  res.status(200).json({ success: true, message: "Slip uploaded successfully", fileName: req.file.filename });
});

const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = getLocalUploadPath("doc");
    if (!uploadDir) return cb(new Error("Failed to get document upload directory."));
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const safeOriginalName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, уникальныйСуффикс + '-' + safeOriginalName);
  },
});
const uploadDocument = multer({ 
    storage: documentStorage,
    limits: { fileSize: 20 * 1024 * 1024 } // 20MB limit for documents
    // Add fileFilter for documents if needed (e.g., PDF, DOCX)
});

app.post("/uploadDocument", uploadDocument.single("document"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No document file uploaded." });
  }
  // For local files, client would typically not get the full server path.
  // If these files need to be served, use express.static and provide relative paths/filenames.
  res.status(200).json({
    success: true,
    message: "Document uploaded successfully",
    fileName: req.file.filename, // Send just the filename
  });
});


// Static serving for locally uploaded images/docs IF NEEDED (consider S3 for production)
const localUploadsDir = getLocalUploadPath(""); // Gets base 'uploads' dir
if (localUploadsDir) {
    app.use("/uploads", express.static(localUploadsDir));
    console.log(`Serving local uploads from ${localUploadsDir} at /uploads`);
}


//--------------------------------------------------- S3 IMAGE UPLOAD (Preferred for Cloud) ---------------------------------------------------

const createS3UploadHandler = (fieldName, s3SubFolder) => {
  return async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: `No file uploaded (field '${fieldName}')` });
    }
    const { originalname, buffer } = req.file;

    // emp_id is already decrypted by middleware
    const empId = req.query.emp_id || (req.body && req.body.emp_id); // Prefer decrypted one
    if (!empId) {
      return res.status(400).json({ error: "Invalid or missing emp_id (decrypted)" });
    }
     if (!process.env.AWS_BUCKET) {
      console.error("AWS_BUCKET environment variable is not set.");
      return res.status(500).json({ error: "Server configuration error for S3 upload."});
    }


    try {
      const rows = await new Promise((resolve, reject) => { // Using companydb for employee lookup
        companydb.query("SELECT emp_database FROM employee WHERE emp_id = ?", [empId], (err, results) => (err ? reject(err) : resolve(results)));
      });
      if (!rows || rows.length === 0) {
        return res.status(404).json({ error: `Employee not found for emp_id: ${empId}` });
      }
      const companyFolder = rows[0].emp_database;
      if (!companyFolder) {
        return res.status(500).json({ error: `Configuration error: emp_database not found for employee ${empId}` });
      }

      const webpBuffer = await sharp(buffer).webp({ quality: 80 }).toBuffer();
      
      let key;
      const baseName = path.basename(originalname, path.extname(originalname)).replace(/[^a-zA-Z0-9_-]/g, '_'); // Sanitize basename
      const timestamp = Date.now();
      
      if (req.body && req.body.fileName) { // If client provides a desired (sanitized) name
         const clientFileNameBase = path.basename(req.body.fileName, path.extname(req.body.fileName)).replace(/[^a-zA-Z0-9_-]/g, '_');
         key = `${companyFolder}/public/${s3SubFolder}/${clientFileNameBase}_${timestamp}.webp`;
      } else {
         key = `${companyFolder}/public/${s3SubFolder}/${baseName}_${timestamp}.webp`;
      }


      const cmd = new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET,
        Key: key,
        ContentType: "image/webp",
        // ACL: 'public-read', // If your bucket isn't public by default and you need direct S3 URLs
      });
      const presignedUrl = await getSignedUrl(s3, cmd, { expiresIn: 300 }); // 5 minutes to upload

      // Construct the public URL. This assumes your bucket objects are publicly readable
      // or you are using CloudFront.
      const publicUrl = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION || 'your-default-aws-region'}.amazonaws.com/${key}`;

      return res.json({ presignedUrl, publicUrl, key }); // Return key for easier deletion/reference
    } catch (err) {
      console.error(`Error in S3 upload handler for ${fieldName}:`, err.message, err.stack);
      return res.status(500).json({ error: err.message || "Internal server error during S3 upload" });
    }
  };
};

app.post("/uploadPackageImage", uploadMemory.single("packageImage"), createS3UploadHandler("packageImage", "package"));
app.post("/uploadItemImage", uploadMemory.single("itemImage"), createS3UploadHandler("itemImage", "item"));
app.post("/uploadVerifyImg", uploadMemory.single("verifyImg"), createS3UploadHandler("verifyImg", "verify")); // 'uploads' was original prefix, changed to 'verify'

// DELETING LOCAL FILES (These routes are problematic on ephemeral filesystems like Railway)
// Consider if these are still needed or if S3 deletion is primary.
// If keeping, ensure photo_url is just the filename for local files.

app.post("/deleteLogoImages", (req, res) => { // Assumes photo_url is a filename prefix for local files
  if (!req.body || typeof req.body.photo_url !== 'string') {
    return res.status(400).json({ success: false, message: "photo_url (string) is required." });
  }
  const { photo_url } = req.body;
  const imgDir = getLocalUploadPath("img");
  if (!imgDir) return res.status(500).json({success: false, message: "Image directory not configured."});

  try {
    if (fs.existsSync(imgDir)) {
      const files = fs.readdirSync(imgDir);
      const logoFiles = files.filter((file) => file.startsWith(photo_url));
      let deletedCount = 0;
      logoFiles.forEach((file) => {
        try {
          fs.unlinkSync(path.join(imgDir, file));
          console.log(`Locally deleted file: ${file}`);
          deletedCount++;
        } catch (e) {
          console.error(`Error deleting local file ${file}:`, e.message);
        }
      });
      res.status(200).json({ success: true, message: `Attempted to delete ${logoFiles.length} local logo image(s), successfully deleted ${deletedCount}.` });
    } else {
      res.status(200).json({ success: true, message: "Image directory does not exist, 0 files deleted." });
    }
  } catch (error) {
    console.error("Error handling local deleteLogoImages request:", error.message);
    res.status(500).json({ success: false, message: "Internal server error during local file deletion." });
  }
});

// This route is identical to deleteLogoImages logic-wise, might be redundant
app.post("/deletePackageImages", (req, res) => {
  if (!req.body || typeof req.body.photo_url !== 'string') {
    return res.status(400).json({ success: false, message: "photo_url (string) is required." });
  }
  const { photo_url } = req.body;
  const imgDir = getLocalUploadPath("img");
   if (!imgDir) return res.status(500).json({success: false, message: "Image directory not configured."});

  try {
    if (fs.existsSync(imgDir)) {
      const files = fs.readdirSync(imgDir);
      const packageFiles = files.filter((file) => file.startsWith(photo_url)); // Assuming prefix match
      let deletedCount = 0;
      packageFiles.forEach((file) => {
        try {
          fs.unlinkSync(path.join(imgDir, file));
          console.log(`Locally deleted package image: ${file}`);
          deletedCount++;
        } catch (e) {
          console.error(`Error deleting local package image ${file}:`, e.message);
        }
      });
      res.status(200).json({ success: true, message: `Attempted to delete ${packageFiles.length} local package image(s), successfully deleted ${deletedCount}.` });
    } else {
      res.status(200).json({ success: true, message: "Image directory does not exist, 0 files deleted." });
    }
  } catch (error) {
    console.error("Error handling local deletePackageImages request:", error.message);
    res.status(500).json({ success: false, message: "Internal server error during local file deletion." });
  }
});


app.post("/deleteImagesByName", (req, res) => { // Deletes a single local file by exact name
  if (!req.body || typeof req.body.photo_url !== 'string') {
    return res.status(400).json({ success: false, message: "photo_url (filename string) is required." });
  }
  const { photo_url: fileName } = req.body;
  const imgDir = getLocalUploadPath("img"); // Assuming images are in 'img' subfolder
  if (!imgDir) return res.status(500).json({success: false, message: "Image directory not configured."});

  const filePath = path.join(imgDir, path.basename(fileName)); // Sanitize to prevent path traversal

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Locally deleted file by name: ${fileName}`);
      res.status(200).json({ success: true, message: `Local file ${fileName} deleted successfully.` });
    } else {
      res.status(404).json({ success: false, message: `Local file ${fileName} not found.` });
    }
  } catch (error) {
    console.error("Error handling local deleteImagesByName request:", error.message);
    res.status(500).json({ success: false, message: "Internal server error during local file deletion." });
  }
});


// Example search (ensure DB is switched if needed)
app.get("/searchByTracking", async (req, res) => {
  const { trackingNumber, emp_id } = req.query;
  if (!trackingNumber) {
    return res.status(400).json({ error: "trackingNumber is required." });
  }
  try {
    await switchToEmployeeDB(emp_id); // Switch DB based on logged-in user
    const results = await q(
      `SELECT c.customer_id, c.contact, c.type, c.level, c.note
       FROM customers c
       INNER JOIN packages p ON c.customer_id = p.customer_id
       WHERE p.tracking_number = ?`,
      [trackingNumber]
    );
    if (results.length === 0) {
        return res.status(404).json({ error: "No customer found for this tracking number."});
    }
    res.json(results); // Returns array of customers (usually one)
  } catch (e) {
    console.error("Error in /searchByTracking:", e.msg || e.message, e.err || '');
    res.status(e.status || 500).json({ error: e.msg || "Error fetching customer by tracking number" });
  }
});

// Global error handler (simple version)
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.stack);
  // Avoid sending stack trace in production
  const errorMessage = process.env.NODE_ENV === 'production' ? 'An unexpected error occurred.' : err.message;
  res.status(err.status || 500).json({ error: errorMessage, ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }) });
});


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});