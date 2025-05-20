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
  "RAILWAY_VOLUME_MOUNT_PATH", // Crucial for file-based settings/local uploads
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.warn(`Warning: Environment variable ${envVar} is not set.`);
    // If RAILWAY_VOLUME_MOUNT_PATH is essential for your app's core functionality
    // (e.g., settings files MUST be on a volume), make it a fatal error.
    if (envVar === "RAILWAY_VOLUME_MOUNT_PATH") {
      // Check if local file features are actually used. If only S3 is used, this might not be critical.
      // For this app, it seems settings files depend on it.
      console.error(
        `FATAL: Environment variable ${envVar} is required for file-based settings and local uploads, but it's not set. Ensure a volume is attached in Railway if these features are needed.`
      );
      process.exit(1); // Exit if critical FS path is missing
    }
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
  console.warn(
    "AWS credentials (AWS_ACCESS_KEY, AWS_SECRET_KEY) are not set. S3 operations might fail if IAM roles are not configured properly on Railway (less common for direct S3 SDK use)."
  );
}

const s3 = new S3Client(s3ClientConfig);

/* ===== AES key (ควรเก็บใน .env) ===== */
const EMP_KEY = process.env.EMP_ID_KEY || "sky45678you"; // This default is for development only.

function decryptEmpId(enc) {
  if (!enc || typeof enc !== "string") return null;
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
      req.query.emp_id_raw = req.query.emp_id;
      req.query.emp_id = plain;
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

const dbConfig = {
  host: process.env.DB_HOST || "th257.ruk-com.in.th",
  user: process.env.DB_USER || "sharebil_sky4you",
  password: process.env.DB_PASSWORD || "LN5avYu2KUwGDR6Ytreg",
  port: process.env.DB_PORT || "3306",
  database: process.env.DB_NAME || "sharebil_sky4you",
  timezone: "+07:00",
};

const db = mysql.createConnection(dbConfig);
const companydb = mysql.createConnection(dbConfig);

// Make DB connections critical for startup
let dbConnected = false;
let companyDbConnected = false;

db.connect((err) => {
  if (err) {
    console.error("FATAL: Error connecting to main DB:", err.stack);
    process.exit(1); // Exit if DB connection fails
  }
  console.log("Connected to main DB as id", db.threadId);
  dbConnected = true;
  startServerIfReady();
});

companydb.connect((err) => {
  if (err) {
    console.error("FATAL: Error connecting to company DB:", err.stack);
    process.exit(1); // Exit if DB connection fails
  }
  console.log("Connected to company DB as id", companydb.threadId);
  companyDbConnected = true;
  startServerIfReady();
});

/**
 * ดึง S3 object key จาก URL ของ S3
 * @param {string} url URL เต็มของ S3
 * @returns {string|null} S3 object key หรือ null ถ้า URL ไม่ถูกต้อง
 */
function extractS3KeyFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const urlObject = new URL(url);
    // More robust check for S3 hostnames
    if (urlObject.hostname.includes(".s3.") && urlObject.hostname.endsWith(".amazonaws.com")) {
      return urlObject.pathname.startsWith("/")
        ? decodeURIComponent(urlObject.pathname.substring(1)) // Decode URI component for keys with spaces/special chars
        : decodeURIComponent(urlObject.pathname);
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
    console.error(
      "AWS_BUCKET environment variable is not set. Cannot delete S3 object."
    );
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
    console.error(`ไม่สามารถลบอ็อบเจกต์ S3 ${s3Key}:`, error.message, error.stack);
    // Optionally re-throw or handle more gracefully depending on context
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
      return resolve();
    }

    companydb.query(
      "SELECT emp_database, emp_datapass FROM employee WHERE emp_id = ?",
      [emp_id],
      (err, rows) => {
        if (err)
          return reject({
            status: 500,
            msg: "Database error during employee lookup",
            err,
          });
        if (!rows || rows.length === 0)
          return reject({
            status: 404,
            msg: `Employee not found for emp_id: ${emp_id}`,
          });

        const { emp_database, emp_datapass } = rows[0];
        if (!emp_database || !emp_datapass) {
          return reject({
            status: 500,
            msg: `Database credentials not found for employee: ${emp_id}`,
          });
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
            resolve();
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
  const byEmpId = req.body.emp_id !== undefined && req.body.emp_id !== null;

  let sql, params;
  if (byEmpId) {
    sql = "SELECT * FROM `employee` WHERE `emp_id` = ?";
    params = [req.body.emp_id];
  } else {
    if (req.body.username === undefined || req.body.password === undefined) {
      return res.status(400).json({
        error: "Username and password are required for standard login",
      });
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
      console.error(
        `Missing database credentials for employee: ${employee.emp_id}`
      );
      return res.status(500).json({
        error: "Configuration error: Employee database details are missing.",
      });
    }

    db.changeUser(
      {
        user: employee.emp_database,
        password: employee.emp_datapass,
        database: employee.emp_database,
      },
      (changeErr) => {
        if (changeErr) {
          console.error(
            "Error changing database during login:",
            changeErr.message
          );
          return res.status(500).json({ error: "Failed to switch database" });
        }
        return res.json(results);
      }
    );
  });
});

app.post("/logout", (req, res) => {
  db.changeUser(
    {
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
    },
    (changeErr) => {
      if (changeErr) {
        console.error(
          "Error changing database during logout:",
          changeErr.message
        );
        return res.status(500).json({ error: "Failed to switch database" });
      }
      res.json({
        message: "Logout successful, connection reverted to default.",
      });
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
             COUNT(DISTINCT p.tracking_number) AS package_count
      FROM customers c
      LEFT JOIN packages p ON c.customer_id = p.customer_id
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

app.post("/deleteCustomer", async (req, res) => {
  if (!req.body || !req.body.customer_id) {
    return res
      .status(400)
      .json({ success: false, message: "Customer ID is required in body" });
  }
  const { customer_id } = req.body;

  db.beginTransaction(async (txErr) => {
    if (txErr) {
      console.error(
        "Error starting transaction for deleteCustomer:",
        txErr.message
      );
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
      console.error("Tx query error during customer deletion:", err.message, err.stack);
      db.rollback(() =>
        res.status(500).json({
          success: false,
          message: "Failed to delete customer and associated data",
          error: err.message,
        })
      );
    }
  });
});

// ... (Keep other routes as they are, they mostly use async/await and q)
// Search for `getLocalUploadPath` and `imageStorage` / `documentStorage`
// to find the parts related to local file system that need attention for Railway.

// Customer-------------------------------------------------------------------------------------------------------------------
app.get("/customersDetails", async (req, res) => {
  const { id, emp_id } = req.query; 

  if (!id)
    return res.status(400).json({ error: "customer_id (id) is required" });

  try {
    await switchToEmployeeDB(emp_id); 
    const rows = await q("SELECT * FROM customers WHERE customer_id = ?", [id]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "Customer details not found" });
    }
    return res.json(rows);
  } catch (e) {
    console.error(
      "Error in /customersDetails:",
      e.msg || e.message,
      e.err || ""
    );
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "Error fetching customer details" });
  }
});

app.get("/addressesinfo", async (req, res) => {
  const { id, emp_id } = req.query; 

  if (!id)
    return res.status(400).json({ error: "address_id (id) is required" });

  try {
    await switchToEmployeeDB(emp_id); 
    const rows = await q("SELECT * FROM addresses WHERE address_id = ?", [id]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "Address info not found" });
    }
    return res.json(rows);
  } catch (e) {
    console.error("Error in /addressesinfo:", e.msg || e.message, e.err || "");
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "Error fetching address info" });
  }
});

app.get("/customersaddresses", async (req, res) => {
  const { id, emp_id } = req.query;

  if (!id)
    return res.status(400).json({ error: "customer_id (id) is required" });

  try {
    await switchToEmployeeDB(emp_id);
    const rows = await q("SELECT * FROM addresses WHERE customer_id = ?", [id]);
    return res.json(rows);
  } catch (e) {
    console.error(
      "Error in /customersaddresses:",
      e.msg || e.message,
      e.err || ""
    );
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "Error fetching customer addresses" });
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
        p.Date_create AS received_date, 
        COALESCE(SUM(CASE WHEN i.item_status = 0 THEN 1 ELSE 0 END), 0) AS sum0,
        COALESCE(SUM(CASE WHEN i.item_status = 1 THEN 1 ELSE 0 END), 0) AS sum1
      FROM packages p
      LEFT JOIN items i ON p.tracking_number = i.tracking_number
      WHERE ${
        processedId === null ? "p.customer_id IS NULL" : "p.customer_id = ?"
      }
      GROUP BY p.tracking_number, p.Date_create 
      ORDER BY p.Date_create DESC; 
    `;
    const params = processedId === null ? [] : [processedId];
    const rows = await q(sql, params);
    return res.json(rows);
  } catch (e) {
    console.error(
      "Error in /customerspackages:",
      e.msg || e.message,
      e.err || ""
    );
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch customer packages" });
  }
});

app.get("/nullpackages", async (req, res) => {
  const { emp_id } = req.query;
  try {
    await switchToEmployeeDB(emp_id);
    const rows = await q(
      "SELECT p.*, p.Date_create AS received_date FROM packages p WHERE p.customer_id IS NULL ORDER BY p.Date_create DESC"
    );
    return res.json(rows);
  } catch (e) {
    console.error("Error in /nullpackages:", e.msg || e.message, e.err || "");
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch null-customer packages" });
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
    console.error("Error in /item:", e.msg || e.message, e.err || "");
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch items by tracking number" });
  }
});

app.post("/additems", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { customer_id, tracking_number, items, emp_id } = req.body;

  if (!customer_id || !tracking_number || !Array.isArray(items)) {
    return res.status(400).json({
      error:
        "Missing or invalid data: customer_id, tracking_number, or items array is required.",
    });
  }

  const values = items
    .filter(
      (it) =>
        it &&
        typeof it.name === "string" &&
        it.name.trim() !== "" &&
        typeof it.mainCategory === "string" &&
        it.mainCategory.trim() !== ""
    )
    .map((it) => [
      tracking_number,
      it.name.trim(),
      it.mainCategory.trim(),
      it.subCategory?.trim() ?? "", 
      Number(it.quantity) || 0,
      Number(it.weight) || 0,
      null, 
      it.photo_url || null,
    ]);

  if (values.length === 0) {
    return res.status(400).json({
      error: "No valid items to insert. Ensure item has name and mainCategory.",
    });
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
    return res.json({
      message: "Items added and customer status updated successfully.",
    });
  } catch (e) {
    console.error("Error in /additems:", e.msg || e.message, e.err || "");
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to add items" });
  }
});

app.post("/edititem", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
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

  if (!item_id || !item_name || !item_type) {
    return res
      .status(400)
      .json({ error: "Missing required data: item_id, item_name, item_type." });
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
    console.error("Error in /edititem:", e.msg || e.message, e.err || "");
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to edit item" });
  }
});

app.post("/deleteitem", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { customer_id, item_id, emp_id } = req.body;

  if (!item_id) {
    return res.status(400).json({ error: "Missing item_id" });
  }

  try {
    await switchToEmployeeDB(emp_id);

    db.beginTransaction(async (txErr) => {
      if (txErr) {
        console.error("Transaction start error in /deleteitem:", txErr.message);
        return res
          .status(500)
          .json({ error: "Transaction error", details: txErr.message });
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

        const deleteResult = await q("DELETE FROM items WHERE item_id = ?", [
          item_id,
        ]);
        if (deleteResult.affectedRows === 0) {
          console.warn(
            `Item with id ${item_id} not found for deletion or already deleted.`
          );
        }

        let message = "Item deleted successfully.";
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
            message = "Item deleted and customer status potentially updated.";
          }
        }

        db.commit((commitErr) => {
          if (commitErr) {
            console.error("Commit error in /deleteitem:", commitErr.message);
            return db.rollback(() =>
              res
                .status(500)
                .json({ error: "Commit failed", details: commitErr.message })
            );
          }
          return res.json({ message });
        });
      } catch (err) {
        console.error("Error during /deleteitem transaction:", err.message, err.stack);
        db.rollback(() =>
          res
            .status(500)
            .json({ error: "Failed to delete item", details: err.message })
        );
      }
    });
  } catch (e) {
    console.error(
      "Error switching DB for /deleteitem:",
      e.msg || e.message,
      e.err || ""
    );
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "DB switch failed" });
  }
});

app.post("/editwarehouse", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { customer_id: id, warehouse, emp_id } = req.body;

  if (!id || warehouse === undefined) {
    return res
      .status(400)
      .json({ error: "customer_id and warehouse are required." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    await q(
      "UPDATE `customers` SET `warehouse` = ? WHERE `customers`.`customer_id` = ?;",
      [warehouse, id]
    );
    res.json({ message: "Warehouse updated successfully." });
  } catch (e) {
    console.error("Error in /editwarehouse:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to update warehouse." });
  }
});

app.post("/createcus", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { customer_id: id, contact, type, level, note, emp_id } = req.body;

  if (!id || !contact) {
    return res
      .status(400)
      .json({ error: "customer_id and contact are required." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    const result = await q(
      "INSERT INTO `customers` (`customer_id`, `contact`, `type`, `level`, `note`) VALUES (?, ?, ?, ?, ?);",
      [id, contact, type, level, note]
    );
    res.json({
      message: "Customer created successfully.",
      customerId: id,
      insertId: result.insertId,
    });
  } catch (e) {
    console.error("Error in /createcus:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to create customer." });
  }
});

app.post("/editcus", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const {
    old_id,
    customer_id: id,
    contact,
    type,
    level,
    note,
    emp_id,
  } = req.body;

  if (!old_id || !id || !contact) {
    return res
      .status(400)
      .json({ error: "old_id, customer_id, and contact are required." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    await q(
      "UPDATE customers SET customer_id = ?, contact = ?, type = ?, level = ?, note = ? WHERE customer_id = ?;",
      [id, contact, type, level, note, old_id]
    );
    res.json({ message: "Customer edited successfully." });
  } catch (e) {
    console.error("Error in /editcus:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to edit customer." });
  }
});

app.post("/addaddr", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const {
    customer_id,
    recipient_name,
    phone,
    address,
    city,
    state,
    country,
    zipcode,
    email,
    emp_id,
  } = req.body;

  if (
    !customer_id ||
    !recipient_name ||
    !address ||
    !city ||
    !country ||
    !zipcode
  ) {
    return res.status(400).json({ error: "Missing required address fields." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    const result = await q(
      "INSERT INTO `addresses` (`customer_id`, `recipient_name`, `phone`, `address`, `city`, `state`, `country`, `zipcode`, `email`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);",
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
      ]
    );
    res.json({
      message: "Address added successfully.",
      addressId: result.insertId,
    });
  } catch (e) {
    console.error("Error in /addaddr:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to add address." });
  }
});

app.post("/editaddr", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const {
    address_id,
    recipient_name,
    phone,
    address,
    city,
    state,
    country,
    zipcode,
    emp_id, // Added emp_id
    email // Added email
  } = req.body;

  if (
    !address_id ||
    !recipient_name ||
    !address ||
    !city ||
    !country ||
    !zipcode
  ) {
    return res
      .status(400)
      .json({ error: "Missing required address fields for editing." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    await q(
      "UPDATE `addresses` SET `recipient_name` = ?, `phone` = ?, `address` = ?, `city` = ?, `state` = ?, `country` = ?, `zipcode` = ?, `email` = ? WHERE `address_id` = ?;", // Added email to update
      [
        recipient_name,
        phone,
        address,
        city,
        state,
        country,
        zipcode,
        email, // Added email param
        address_id,
      ]
    );
    res.json({ message: "Address edited successfully." });
  } catch (e) {
    console.error("Error in /editaddr:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to edit address." });
  }
});

app.post("/deleteaddr", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { address_id, emp_id } = req.body;

  if (!address_id) {
    return res.status(400).json({ error: "address_id is required." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    const result = await q(
      "DELETE FROM addresses WHERE `addresses`.`address_id` = ?;",
      [address_id]
    );
    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ error: "Address not found or already deleted." });
    }
    res.json({ message: "Address deleted successfully." });
  } catch (e) {
    console.error("Error in /deleteaddr:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to delete address." });
  }
});

app.post("/addpackage", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { customer_id, tracking_number, photo_url, packages_cost, emp_id } =
    req.body;

  if (!tracking_number) {
    return res.status(400).json({ error: "tracking_number is required." });
  }
  const processedcustomer_id =
    customer_id === "MISSINGITEMS" ||
    customer_id === "" ||
    customer_id === undefined
      ? null
      : customer_id;

  try {
    await switchToEmployeeDB(emp_id);
    let sql, params;
    if (packages_cost !== undefined) {
      sql =
        "INSERT INTO `packages` (`tracking_number`, `customer_id`, `packages_cost`, `photo_url`) VALUES (?, ?, ?, ?);";
      params = [
        tracking_number,
        processedcustomer_id,
        Number(packages_cost) || 0,
        photo_url || null,
      ];
    } else {
      sql =
        "INSERT INTO `packages` (`tracking_number`, `customer_id`, `photo_url`) VALUES (?, ?, ?);";
      params = [tracking_number, processedcustomer_id, photo_url || null];
    }
    await q(sql, params);
    res.json({ message: "Package added successfully." });
  } catch (e) {
    console.error("Error in /addpackage:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to add package." });
  }
});

app.post("/editpackage", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { old_id, customer_id, tracking_number, photo_url, emp_id } = req.body;

  if (!old_id || !tracking_number) {
    return res.status(400).json({
      error:
        "old_id (original tracking number) and new tracking_number are required.",
    });
  }
  const processedcustomer_id =
    customer_id === "MISSINGITEMS" ||
    customer_id === "" ||
    customer_id === undefined
      ? null
      : customer_id;

  try {
    await switchToEmployeeDB(emp_id);
    await q(
      "UPDATE `packages` SET `tracking_number` = ?, `customer_id` = ?, `photo_url` = ? WHERE `packages`.`tracking_number` = ?;",
      [tracking_number, processedcustomer_id, photo_url || null, old_id]
    );
    res.json({ message: "Package edited successfully." });
  } catch (e) {
    console.error("Error in /editpackage:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to edit package." });
  }
});

app.post("/deletepackage", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { customer_id, tracking, emp_id } = req.body;

  if (!tracking) {
    return res
      .status(400)
      .json({ error: "Tracking number (tracking) is required" });
  }

  try {
    await switchToEmployeeDB(emp_id);
    db.beginTransaction(async (txErr) => {
      if (txErr) {
        console.error(
          "Transaction start error in /deletepackage:",
          txErr.message
        );
        return res
          .status(500)
          .json({ error: "Transaction error", details: txErr.message });
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
        const packageDeleteResult = await q(
          "DELETE FROM packages WHERE tracking_number = ?",
          [tracking]
        );

        if (packageDeleteResult.affectedRows === 0) {
          console.warn(
            `Package with tracking ${tracking} not found for deletion or already deleted.`
          );
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
            message =
              "Package and items deleted. Customer status potentially updated.";
          }
        }

        db.commit((commitErr) => {
          if (commitErr) {
            console.error("Commit error in /deletepackage:", commitErr.message);
            return db.rollback(() =>
              res.status(500).json({
                error: "Failed to commit transaction",
                details: commitErr.message,
              })
            );
          }
          res.json({ message });
        });
      } catch (err) {
        console.error("Error during /deletepackage transaction:", err.message, err.stack);
        db.rollback(() =>
          res.status(500).json({
            error: "Failed to delete package and associated data",
            details: err.message,
          })
        );
      }
    });
  } catch (e) {
    console.error(
      "Error switching DB for /deletepackage:",
      e.msg || e.message,
      e.err || ""
    );
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "DB switch failed" });
  }
});

// SubBox -------------------------------------------------------------------------------------------------------------------
app.get("/remainboxitem", async (req, res) => {
  const { box_id, emp_id } = req.query;
  if (!box_id) {
    return res.status(400).json({ error: "box_id is required." });
  }
  const query = `SELECT bi.*, 
            bi.quantity - COALESCE(SUM(sbi.sub_quantity), 0) AS remaining_quantity, 
            CASE 
                WHEN bi.quantity = 0 THEN 0 
                ELSE bi.weight * (bi.quantity - COALESCE(SUM(sbi.sub_quantity), 0)) / bi.quantity 
            END AS adjusted_weight 
     FROM items bi 
     LEFT JOIN subbox sb ON bi.box_id = sb.box_id 
     LEFT JOIN subbox_item sbi ON sb.subbox_id = sbi.subbox_id AND bi.item_id = sbi.item_id 
     WHERE bi.box_id = ? 
     GROUP BY bi.item_id, bi.tracking_number, bi.item_name, bi.item_type, bi.item_subtype, bi.quantity, bi.weight, bi.packer_id, bi.photo_url, bi.box_id, bi.item_status, bi.Date_create /* Added all non-aggregated columns */
     HAVING remaining_quantity != 0;`;
  try {
    await switchToEmployeeDB(emp_id);
    const results = await q(query, [box_id]);
    res.json(results);
  } catch (e) {
    console.error("Error in /remainboxitem:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch remaining box items." });
  }
});

app.get("/itemsubbox", async (req, res) => {
  const { subbox_id, emp_id } = req.query;
  if (!subbox_id) {
    return res.status(400).json({ error: "subbox_id is required." });
  }
  const query = `SELECT sbi.*, i.item_name, i.item_type, i.item_subtype, i.packer_id, i.photo_url, i.box_id, i.item_status, i.Date_create,
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
    console.error("Error in /itemsubbox:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch item subbox details." });
  }
});

app.post("/edititemsubbox", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { subbox_id, items, emp_id } = req.body;

  if (
    !subbox_id ||
    typeof items !== "object" ||
    items === null ||
    Array.isArray(items)
  ) {
    return res
      .status(400)
      .json({ error: "subbox_id and items (as an object) are required." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    const updateQuery =
      "UPDATE `subbox_item` SET `sub_quantity` = ? WHERE `subbox_id` = ? AND `item_id` = ?;";
    const deleteQuery =
      "DELETE FROM `subbox_item` WHERE `subbox_id` = ? AND `item_id` = ?;";

    const promises = Object.entries(items).map(
      async ([item_id, sub_quantity_val]) => {
        const sub_quantity = Number(sub_quantity_val);
        if (isNaN(sub_quantity)) {
          throw new Error(
            `Invalid sub_quantity for item_id ${item_id}: ${sub_quantity_val}`
          );
        }
        if (sub_quantity === 0) {
          await q(deleteQuery, [subbox_id, item_id]);
          return { action: "deleted", item_id };
        } else {
          await q(updateQuery, [sub_quantity, subbox_id, item_id]);
          return { action: "updated", item_id, sub_quantity };
        }
      }
    );

    const results = await Promise.all(promises);
    res.json({ message: "All items updated successfully", results });
  } catch (e) {
    console.error("Error in /edititemsubbox:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to update subbox items." });
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
    res.json(results[0]); 
  } catch (e) {
    console.error("Error in /subboxinfo:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch subbox info." });
  }
});

app.post("/addsubbox", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { box_id, weight, width, b_long, height, img_url, items, emp_id } =
    req.body;

  if (!box_id || !Array.isArray(items)) {
    return res
      .status(400)
      .json({ error: "box_id and items array are required." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    const query1 =
      "INSERT INTO `subbox` (`box_id`, `weight`, `width`, `b_long`, `height`, `img_url`) VALUES (?, ?, ?, ?, ?, ?);";
    const result1 = await q(query1, [
      box_id,
      Number(weight) || 0,
      Number(width) || 0,
      Number(b_long) || 0,
      Number(height) || 0,
      img_url || null,
    ]);
    const subboxId = result1.insertId;

    if (items.length > 0) {
      const values = items.map((item) => {
        if (!item || item.item_id === undefined || item.selectedQuantity === undefined || item.remaining_quantity === undefined ) // Added check for selectedQuantity and remaining_quantity
          throw new Error("Invalid item structure in items array. Needs item_id, selectedQuantity, remaining_quantity.");
        const quantity = Number(item.selectedQuantity);
        const remaining = Number(item.remaining_quantity);
        return [subboxId, item.item_id, quantity === 0 ? remaining : quantity];
      });
      const query2 =
        "INSERT INTO `subbox_item` (`subbox_id`, `item_id`, `sub_quantity`) VALUES ?;";
      await q(query2, [values]);
    }
    res.json({ message: "Subbox and items added successfully", subboxId });
  } catch (e) {
    console.error("Error in /addsubbox:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to add subbox." });
  }
});

app.post("/editsubbox", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { subbox_id, weight, width, b_long, height, img_url, emp_id } =
    req.body;

  if (!subbox_id) {
    return res.status(400).json({ error: "subbox_id is required." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    const query1 =
      "UPDATE `subbox` SET `weight` = ?, `width` = ?, `b_long` = ?, `height` = ?, `img_url` = ? WHERE `subbox_id` = ?;";
    await q(query1, [
      Number(weight) || 0,
      Number(width) || 0,
      Number(b_long) || 0,
      Number(height) || 0,
      img_url || null,
      subbox_id,
    ]);
    res.json({ message: "Subbox edited successfully." });
  } catch (e) {
    console.error("Error in /editsubbox:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to edit subbox." });
  }
});

app.post("/editsubbox_track", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const {
    subbox_id: subboxIds,
    subbox_tracking,
    subbox_cost,
    emp_id,
  } = req.body; 

  if (
    !Array.isArray(subboxIds) ||
    !Array.isArray(subbox_tracking) ||
    !Array.isArray(subbox_cost)
  ) {
    return res.status(400).json({
      error: "subbox_id, subbox_tracking, and subbox_cost must be arrays.",
    });
  }
  if (
    subboxIds.length !== subbox_tracking.length ||
    subboxIds.length !== subbox_cost.length
  ) {
    return res
      .status(400)
      .json({ error: "Input arrays must have the same length." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    const query1 =
      "UPDATE `subbox` SET `subbox_tracking` = ?, `subbox_cost` = ? WHERE `subbox_id` = ?";

    const updates = subboxIds.map((idObj, index) => {
      const currentSubboxId =
        idObj && idObj.subbox_id !== undefined ? idObj.subbox_id : idObj;
      if (currentSubboxId === undefined || currentSubboxId === null) {
        // Throw an error that will be caught by the outer catch block
        const err = new Error(`Invalid subbox_id at index ${index}. Value: ${JSON.stringify(idObj)}`);
        err.status = 400; // Custom property for status code
        throw err;
      }
      return q(query1, [
        subbox_tracking[index] || null,
        Number(subbox_cost[index]) || 0,
        currentSubboxId,
      ]);
    });

    await Promise.all(updates);
    res.json({ message: "All subbox tracking info edited successfully." });
  } catch (e) {
    console.error(
      "Error in /editsubbox_track:",
      e.msg || e.message,
      e.err || ""
    );
    res
      .status(e.status || 500)
      .json({ error: e.msg || e.message || "Failed to update subbox tracking info." });
  }
});

app.post("/deletesubbox", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { subbox_id, emp_id } = req.body;

  if (!subbox_id) {
    return res.status(400).json({ error: "subbox_id is required." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    db.beginTransaction(async (txErr) => {
      if (txErr) {
        console.error(
          "Transaction start error in /deletesubbox:",
          txErr.message
        );
        return res
          .status(500)
          .json({ error: "Transaction error", details: txErr.message });
      }
      try {
        // Fetch subbox details to get img_url for S3 deletion
        const [subboxDetails] = await q("SELECT img_url FROM subbox WHERE subbox_id = ?", [subbox_id]);
        if (subboxDetails && subboxDetails.img_url) {
            const s3Key = extractS3KeyFromUrl(subboxDetails.img_url);
            if (s3Key) {
                await deleteS3Object(s3Key);
            }
        }

        await q("DELETE FROM subbox_item WHERE `subbox_id` = ?;", [subbox_id]);
        const subboxDeleteResult = await q(
          "DELETE FROM subbox WHERE `subbox_id` = ?;",
          [subbox_id]
        );

        if (subboxDeleteResult.affectedRows === 0) {
          console.warn(
            `Subbox with id ${subbox_id} not found for deletion or already deleted. Still committing item deletions.`
          );
        }

        db.commit((commitErr) => {
          if (commitErr) {
            console.error("Commit error in /deletesubbox:", commitErr.message);
            return db.rollback(() =>
              res
                .status(500)
                .json({ error: "Commit failed", details: commitErr.message })
            );
          }
          res.json({
            success: true,
            message: "Subbox, associated items, and S3 image (if exists) deleted successfully",
          });
        });
      } catch (err) {
        console.error("Error during /deletesubbox transaction:", err.message, err.stack);
        db.rollback(() =>
          res
            .status(500)
            .json({ error: "Failed to delete subbox", details: err.message })
        );
      }
    });
  } catch (e) {
    console.error(
      "Error switching DB for /deletesubbox:",
      e.msg || e.message,
      e.err || ""
    );
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "DB switch failed" });
  }
});

app.post("/addsubboxitem", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { items, subbox_id, emp_id } = req.body;

  if (!subbox_id || !Array.isArray(items) || items.length === 0) {
    return res
      .status(400)
      .json({ error: "subbox_id and a non-empty items array are required." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    const values = items.map((item) => {
      if (
        !item ||
        item.item_id === undefined ||
        item.quantity === undefined || // Assuming 'quantity' refers to 'selectedQuantity' in prior logic
        item.remaining_quantity === undefined
      ) {
        throw new Error(
          "Invalid item structure in items array. Each item needs item_id, quantity (selected), and remaining_quantity."
        );
      }
      const quantity = Number(item.quantity); // Use 'quantity' as passed in the 'items' array for this route
      const remaining = Number(item.remaining_quantity);
      // The logic for using remaining_quantity if quantity is 0 might depend on the frontend's intent here.
      // If item.quantity is meant to be the amount *to add*, this is correct.
      return [subbox_id, item.item_id, quantity === 0 ? remaining : quantity];
    });

    const query =
      "INSERT INTO subbox_item (subbox_id, item_id, sub_quantity) VALUES ? ON DUPLICATE KEY UPDATE sub_quantity = sub_quantity + VALUES(sub_quantity);";
    await q(query, [values]);
    res.json({ message: "Subbox items added/updated successfully." });
  } catch (e) {
    console.error("Error in /addsubboxitem:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to add/update subbox items." });
  }
});


// Box -------------------------------------------------------------------------------------------------------------------
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
    res.json(results[0]); 
  } catch (e) {
    console.error("Error in /box:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch box details." });
  }
});

app.post("/addbox", async (req, res) => {
  if (!req.body || !req.body.submissionData) {
    return res
      .status(400)
      .json({ error: "Request body with submissionData is missing." });
  }
  const { sender, recipients, note, packages } = req.body.submissionData;
  const { emp_id } = req.body; 

  if (!sender || !recipients || !Array.isArray(packages)) {
    return res.status(400).json({
      error:
        "Missing required fields in submissionData: sender, recipients, or packages array.",
    });
  }

  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(now.getDate()).padStart(2, "0")}`;
  const time = `${String(now.getHours()).padStart(2, "0")}${String(
    now.getMinutes()
  ).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`; 
  const box_id = `${sender}_${date}T${time}`;

  try {
    await switchToEmployeeDB(emp_id);
    db.beginTransaction(async (txErr) => {
      if (txErr) {
        console.error("Transaction start error in /addbox:", txErr.message);
        return res
          .status(500)
          .json({ error: "Transaction error", details: txErr.message });
      }
      try {
        await q(
          "INSERT INTO `box` (`box_id`, `customer_id`, `address_id`, `note`) VALUES (?, ?, ?, ?)",
          [box_id, sender, recipients, note || null]
        );

        const itemUpdatePromises = [];
        packages.forEach((pkg) => {
          if (pkg && Array.isArray(pkg.items)) {
            pkg.items.forEach((item) => {
              if (item && item.item_id !== undefined) {
                itemUpdatePromises.push(
                  q(
                    "UPDATE `items` SET `box_id` = ?, `item_status` = 1 WHERE `item_id` = ?",
                    [box_id, item.item_id]
                  )
                );
              }
            });
          }
        });
        await Promise.all(itemUpdatePromises);
        await q( // This status update might need more nuance based on other statuses
          "UPDATE `customers` SET `packages` = `packages` + 1, `status` = 'Ordered' WHERE `customer_id` = ?",
          [sender]
        );

        db.commit((commitErr) => {
          if (commitErr) {
            console.error("Commit error in /addbox:", commitErr.message);
            return db.rollback(() =>
              res
                .status(500)
                .json({ error: "Commit failed", details: commitErr.message })
            );
          }
          res.json({
            message: "Box and items added successfully",
            boxId: box_id,
          });
        });
      } catch (err) {
        console.error("Error during /addbox transaction:", err.message, err.stack);
        db.rollback(() =>
          res
            .status(500)
            .json({ error: "Failed to add box", details: err.message })
        );
      }
    });
  } catch (e) {
    console.error(
      "Error switching DB for /addbox:",
      e.msg || e.message,
      e.err || ""
    );
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "DB switch failed" });
  }
});

app.post("/deletebox", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { customer_id, box_id, emp_id } = req.body;

  if (!box_id) {
    return res.status(400).json({ error: "box_id is required." });
  }
  if (!customer_id) {
    return res
      .status(400)
      .json({ error: "customer_id is required for status update logic." });
  }

  try {
    await switchToEmployeeDB(emp_id);
    db.beginTransaction(async (txErr) => {
      if (txErr) {
        console.error("Transaction start error in /deletebox:", txErr.message);
        return res
          .status(500)
          .json({ error: "Transaction error", details: txErr.message });
      }
      try {
        await q(
          "UPDATE items SET item_status = 0, box_id = NULL WHERE box_id = ?;",
          [box_id]
        );
        // Delete S3 images for subboxes within this box
        const subboxesInBox = await q("SELECT subbox_id, img_url FROM subbox WHERE box_id = ?", [box_id]);
        for (const subbox of subboxesInBox) {
            if (subbox.img_url) {
                const s3Key = extractS3KeyFromUrl(subbox.img_url);
                if (s3Key) await deleteS3Object(s3Key);
            }
        }

        await q(
          "DELETE FROM subbox_item WHERE subbox_id IN (SELECT subbox_id FROM subbox WHERE box_id = ?)",
          [box_id]
        );
        await q("DELETE FROM subbox WHERE box_id = ?", [box_id]);
        const boxDeleteResult = await q("DELETE FROM box WHERE box_id = ?", [
          box_id,
        ]);

        if (boxDeleteResult.affectedRows > 0) {
          const updateCustomerStatusSQL = `
                UPDATE customers 
                SET packages = GREATEST(0, packages - 1), 
                    status = CASE 
                                WHEN EXISTS (SELECT 1 FROM box WHERE customer_id = ? AND box_status = 'Packed') THEN 'Unpaid' 
                                WHEN EXISTS (SELECT 1 FROM items i JOIN packages p ON i.tracking_number = p.tracking_number WHERE p.customer_id = ? AND i.item_status = 0) THEN 'Warehouse'
                                ELSE NULL
                             END 
                WHERE customer_id = ?`;
          await q(updateCustomerStatusSQL, [
            customer_id,
            customer_id,
            customer_id,
          ]);
        } else {
          console.warn(
            `Box with ID ${box_id} not found for deletion. Customer status not updated.`
          );
        }

        db.commit((commitErr) => {
          if (commitErr) {
            console.error("Commit error in /deletebox:", commitErr.message);
            return db.rollback(() =>
              res
                .status(500)
                .json({ error: "Commit failed", details: commitErr.message })
            );
          }
          res.json({
            message: "Box deleted and statuses updated successfully",
            box_id,
          });
        });
      } catch (err) {
        console.error("Error during /deletebox transaction:", err.message, err.stack);
        db.rollback(() =>
          res
            .status(500)
            .json({ error: "Failed to delete box", details: err.message })
        );
      }
    });
  } catch (e) {
    console.error(
      "Error switching DB for /deletebox:",
      e.msg || e.message,
      e.err || ""
    );
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "DB switch failed" });
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
    res.json(results); 
  } catch (e) {
    console.error("Error in /boxitem:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch box items." });
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
    res.json(results); 
  } catch (e) {
    console.error("Error in /boxslip:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch box slips." });
  }
});

app.get("/subbox", async (req, res) => {
  const { box_id, emp_id } = req.query;
  if (!box_id) {
    return res.status(400).json({ error: "box_id is required." });
  }
  try {
    await switchToEmployeeDB(emp_id);
    const querySubbox = `SELECT sb.*, 
              ROUND(GREATEST(sb.weight, (sb.width * sb.b_long * sb.height) / 5000), 2) AS volumetricWeight 
       FROM subbox sb WHERE sb.box_id = ?;`;
    const subboxes = await q(querySubbox, [box_id]);

    if (subboxes.length === 0) {
      return res.json([]);
    }

    const subboxIds = subboxes.map((sub) => sub.subbox_id);
    const querySubboxItem = `SELECT sbi.*, i.item_name, i.item_type, i.photo_url, i.item_subtype, /* Added item_subtype */
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
    console.error("Error in /subbox:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch subbox details." });
  }
});

app.get("/subbox_box", async (req, res) => {
  const { box_id, emp_id } = req.query;
  if (!box_id) {
    return res.status(400).json({ error: "box_id is required." });
  }
  try {
    await switchToEmployeeDB(emp_id);
    const subboxes = await q("SELECT * FROM subbox WHERE box_id = ?;", [
      box_id,
    ]);
    res.json(subboxes);
  } catch (e) {
    console.error("Error in /subbox_box:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch subboxes for box." });
  }
});

app.post("/createslip", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { slip: slip_img, amount, details, BoxId: box_id, emp_id } = req.body; 

  if (!box_id || slip_img === undefined || amount === undefined) {
    return res
      .status(400)
      .json({ error: "BoxId, slip image URL, and amount are required." });
  }
  try {
    await switchToEmployeeDB(emp_id);
    const result = await q(
      "INSERT INTO `slip` (`box_id`, `slip_img`, `price`, `details`) VALUES (?, ?, ?, ?);",
      [box_id, slip_img, Number(amount) || 0, details || null]
    );
    res.json({
      message: "Slip created successfully.",
      slipId: result.insertId,
    });
  } catch (e) {
    console.error("Error in /createslip:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to create slip." });
  }
});

app.post("/deleteslip", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { slip: slip_id, emp_id } = req.body; 

  if (!slip_id) {
    return res.status(400).json({ error: "slip_id is required." });
  }
  try {
    await switchToEmployeeDB(emp_id);
    // Fetch slip details to get slip_img for S3 deletion
    const [slipDetails] = await q("SELECT slip_img FROM slip WHERE slip_id = ?", [slip_id]);
    if (slipDetails && slipDetails.slip_img) {
        const s3Key = extractS3KeyFromUrl(slipDetails.slip_img);
        if (s3Key) {
            await deleteS3Object(s3Key);
        }
    }

    const result = await q("DELETE FROM slip WHERE `slip_id` = ?;", [slip_id]);
    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ error: "Slip not found or already deleted." });
    }
    res.json({ message: "Slip and S3 image (if exists) deleted successfully." });
  } catch (e) {
    console.error("Error in /deleteslip:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to delete slip." });
  }
});


// packages & completed-------------------------------------------------------------------------------------------------------------------
app.get("/box1", async (req, res) => {
  const { emp_id } = req.query;
  try {
    await switchToEmployeeDB(emp_id);
    const [orderedResults, processResults, packedResults] = await Promise.all([
      q(
        "SELECT * FROM box WHERE box_status = 'Ordered' ORDER BY `priority` ASC, `box_id` DESC;"
      ), 
      q(
        "SELECT * FROM box WHERE box_status = 'Process' ORDER BY `priority` ASC, `box_id` DESC;"
      ),
      q(
        "SELECT * FROM box WHERE box_status = 'Packed' ORDER BY `priority` ASC, `box_id` DESC;"
      ),
    ]);
    res.json({
      Ordered: orderedResults,
      Process: processResults,
      Packed: packedResults,
    });
  } catch (e) {
    console.error("Error in /box1:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch box data (stage 1)." });
  }
});

app.get("/box2", async (req, res) => {
  const { emp_id } = req.query;
  try {
    await switchToEmployeeDB(emp_id);
    const [paidResults, documentedResults] = await Promise.all([
      q(
        "SELECT * FROM box WHERE box_status = 'Paid' ORDER BY `priority` ASC, `box_id` DESC;"
      ),
      q(
        "SELECT * FROM box WHERE box_status = 'Documented' ORDER BY `priority` ASC, `box_id` DESC;"
      ),
    ]);
    res.json({
      Paid: paidResults,
      Documented: documentedResults,
    });
  } catch (e) {
    console.error("Error in /box2:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch box data (stage 2)." });
  }
});

app.post("/editbox", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const {
    box_id,
    box_status,
    bprice,
    customer_id,
    document, // This is expected to be a URL from S3 or local upload
    discount,
    emp_id,
  } = req.body;

  if (!box_id) return res.status(400).json({ error: "box_id is required." });

  try {
    await switchToEmployeeDB(emp_id);
    let mainQuerySql, mainQueryParams;
    let customerStatusUpdateNeeded = false;
    let newCustomerStatus = null; 

    // Fetch current box document URL if we are updating it
    let oldDocumentUrl = null;
    if (document !== undefined) { // If a new document URL is provided or it's being cleared
        const [currentBox] = await q("SELECT document FROM box WHERE box_id = ?", [box_id]);
        if (currentBox && currentBox.document) {
            oldDocumentUrl = currentBox.document;
        }
    }

    if (bprice !== undefined) {
      if (!box_status || !customer_id)
        return res.status(400).json({
          error: "box_status and customer_id are required when bprice is set.",
        });
      mainQuerySql =
        "UPDATE `box` SET `box_status` = ?, `bprice` = ?, `document` = ? WHERE `box_id` = ?;";
      mainQueryParams = [
        box_status,
        Number(bprice) || 0,
        document || null,
        box_id,
      ];
      if (box_status === "Packed") {
        customerStatusUpdateNeeded = true;
        newCustomerStatus = "Unpaid";
      } else {
        customerStatusUpdateNeeded = true;
      }
    } else if (discount !== undefined) {
      mainQuerySql = "UPDATE `box` SET `discount` = ? WHERE `box_id` = ?;";
      mainQueryParams = [Number(discount) || 0, box_id];
    } else if (box_status !== undefined && customer_id !== undefined) {
      mainQuerySql = "UPDATE `box` SET `box_status` = ? WHERE `box_id` = ?;";
      mainQueryParams = [box_status, box_id];
      customerStatusUpdateNeeded = true;
      if (box_status === "Paid") {
        // Stays 'Paid' or logic below determines Warehouse/NULL
      } else {
        newCustomerStatus = "Unpaid"; 
      }
    } else if (box_status !== undefined) {
      mainQuerySql = "UPDATE `box` SET `box_status` = ? WHERE `box_id` = ?;";
      mainQueryParams = [box_status, box_id];
    } else if (document !== undefined) { // Added case for updating only document
        mainQuerySql = "UPDATE `box` SET `document` = ? WHERE `box_id` = ?;";
        mainQueryParams = [document || null, box_id];
    }
    else {
      return res
        .status(400)
        .json({ error: "No valid parameters provided for editbox." });
    }

    await q(mainQuerySql, mainQueryParams);

    // If document was updated and old document existed, delete old S3 object
    if (document !== undefined && oldDocumentUrl && oldDocumentUrl !== document) {
        const s3Key = extractS3KeyFromUrl(oldDocumentUrl);
        if (s3Key) {
            await deleteS3Object(s3Key);
            console.log(`Old S3 document ${s3Key} deleted for box ${box_id}`);
        }
    }


    if (customerStatusUpdateNeeded && customer_id) {
      if (newCustomerStatus === "Unpaid") {
        await q(
          "UPDATE customers SET status = 'Unpaid' WHERE customer_id = ?;",
          [customer_id]
        );
      } else {
        // This logic determines 'Warehouse' or NULL if not explicitly 'Unpaid'
        const [{ count: unpaidItemCount }] = await q(
          `SELECT COUNT(*) AS count FROM items i 
                     JOIN packages p ON i.tracking_number = p.tracking_number 
                     WHERE p.customer_id = ? AND i.item_status = 0`, // Unpacked items
          [customer_id]
        );
        const [{ count: packedBoxCount }] = await q(
            `SELECT COUNT(*) as count FROM box WHERE customer_id = ? AND box_status = 'Packed'`, // Packed but unpaid boxes
            [customer_id]
        );

        let finalStatus = null;
        if (packedBoxCount > 0) {
            finalStatus = 'Unpaid';
        } else if (unpaidItemCount > 0) {
            finalStatus = 'Warehouse';
        }
        // Only update if the status is changing, or if it's not already 'Unpaid' (which has precedence)
        await q(
          "UPDATE customers SET status = ? WHERE customer_id = ? AND (status IS NULL OR status != 'Unpaid' OR ? IS NOT NULL)", 
          // The last part of AND ensures if finalStatus is 'Unpaid', it overwrites. If finalStatus is NULL or Warehouse, it only overwrites non-'Unpaid'.
          [finalStatus, customer_id, finalStatus] 
        );
      }
    }
    res.json({
      message: "Box edited and customer status updated successfully.",
    });
  } catch (e) {
    console.error("Error in /editbox:", e.msg || e.message, e.err || "", e.stack);
    res.status(e.status || 500).json({ error: e.msg || "Failed to edit box." });
  }
});


app.post("/editpriority", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { box_id, priority, emp_id } = req.body;

  if (!box_id || priority === undefined) {
    return res.status(400).json({ error: "box_id and priority are required." });
  }
  try {
    await switchToEmployeeDB(emp_id);
    await q("UPDATE `box` SET `priority` = ? WHERE `box_id` = ?;", [
      Number(priority) || 0,
      box_id,
    ]);
    res.json({ message: "Box priority edited successfully." });
  } catch (e) {
    console.error("Error in /editpriority:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to edit box priority." });
  }
});

// appointment-------------------------------------------------------------------------------------------------------------------
app.get("/appointment", async (req, res) => {
  const { emp_id } = req.query;
  const query =
    "SELECT *, DATE_FORMAT(start_date, '%Y-%m-%d') AS formatted_start_date, TIME_FORMAT(start_date, '%H:%i') AS formatted_start_time FROM appointment WHERE status = 'Pending' AND start_date >= CURDATE() ORDER BY start_date ASC;";
  try {
    await switchToEmployeeDB(emp_id);
    const results = await q(query);
    res.json(results);
  } catch (e) {
    console.error("Error in /appointment:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to fetch appointments." });
  }
});

app.post("/addappoint", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const {
    title, // This is customer_id
    address_pickup,
    phone_pickup,
    name_pickup,
    position,
    vehicle,
    note,
    pickupdate,
    pickupTime,
    emp_id, 
  } = req.body;

  if (!title || !pickupdate || !pickupTime) {
    return res
      .status(400)
      .json({ error: "Title (customer_id), pickupdate, and pickupTime are required." });
  }

  const dateTimeString = `${pickupdate}T${pickupTime}:00`; 
  const startDateTime = new Date(dateTimeString);
  if (isNaN(startDateTime.getTime())) {
    return res.status(400).json({
      error:
        "Invalid pickupdate or pickupTime format. Use YYYY-MM-DD and HH:MM.",
    });
  }

  const formatForMySQL = (dateObj) => {
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, "0");
    const day = String(dateObj.getDate()).padStart(2, "0");
    const hours = String(dateObj.getHours()).padStart(2, "0");
    const minutes = String(dateObj.getMinutes()).padStart(2, "0");
    const seconds = String(dateObj.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  };

  const start_time_mysql = formatForMySQL(startDateTime);
  const endDateTime = new Date(startDateTime.getTime() + 30 * 60000); 
  const end_time_mysql = formatForMySQL(endDateTime);

  const query1 =
    "INSERT INTO `appointment` (`title`, `start_date`, `end_date`, `note`, `customer_id`, `address_pickup`, `phone_pickup`, `name_pickup`, `position`, `vehicle`, `status`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending');";
  try {
    await switchToEmployeeDB(emp_id);
    const result = await q(query1, [
      title, // title field in DB for the event title/summary
      start_time_mysql,
      end_time_mysql,
      note || null,
      title, // customer_id field in DB
      address_pickup || null,
      phone_pickup || null,
      name_pickup || null,
      position || null,
      vehicle || null,
    ]);
    res.json({
      message: "Appointment added successfully.",
      appointId: result.insertId,
    });
  } catch (e) {
    console.error("Error in /addappoint:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to add appointment." });
  }
});

app.post("/editappoint", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const {
    appoint_id: address_id, // appoint_id from DB, frontend sends as 'address_id'
    title, // Added title for editing
    address_pickup,
    phone_pickup,
    name_pickup,
    position,
    vehicle,
    note,
    status, 
    pickupdate,
    pickupTime, 
    emp_id,
  } = req.body;

  if (!address_id) { // This is appoint_id
    return res
      .status(400)
      .json({ error: "appoint_id (as address_id) is required." });
  }

  let start_time_mysql, end_time_mysql;
  if (pickupdate && pickupTime) {
    const dateTimeString = `${pickupdate}T${pickupTime}:00`;
    const startDateTime = new Date(dateTimeString);
    if (isNaN(startDateTime.getTime())) {
      return res.status(400).json({
        error: "Invalid pickupdate or pickupTime format for editing.",
      });
    }
    const formatForMySQL = (dateObj) =>
      `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(
        2,
        "0"
      )}-${String(dateObj.getDate()).padStart(2, "0")} ${String(
        dateObj.getHours()
      ).padStart(2, "0")}:${String(dateObj.getMinutes()).padStart(
        2,
        "0"
      )}:${String(dateObj.getSeconds()).padStart(2, "0")}`;
    start_time_mysql = formatForMySQL(startDateTime);
    const endDateTime = new Date(startDateTime.getTime() + 30 * 60000);
    end_time_mysql = formatForMySQL(endDateTime);
  }

  const updates = [];
  const params = [];

  if (title !== undefined) { // For editing the event title/customer_id
    updates.push("`title` = ?");
    params.push(title);
    updates.push("`customer_id` = ?"); // Assuming title and customer_id are the same
    params.push(title);
  }
  if (note !== undefined) {
    updates.push("`note` = ?");
    params.push(note);
  }
  if (address_pickup !== undefined) {
    updates.push("`address_pickup` = ?");
    params.push(address_pickup);
  }
  if (phone_pickup !== undefined) {
    updates.push("`phone_pickup` = ?");
    params.push(phone_pickup);
  }
  if (name_pickup !== undefined) {
    updates.push("`name_pickup` = ?");
    params.push(name_pickup);
  }
  if (position !== undefined) {
    updates.push("`position` = ?");
    params.push(position);
  }
  if (vehicle !== undefined) {
    updates.push("`vehicle` = ?");
    params.push(vehicle);
  }
  if (status !== undefined) {
    updates.push("`status` = ?");
    params.push(status);
  }
  if (start_time_mysql !== undefined) {
    updates.push("`start_date` = ?");
    params.push(start_time_mysql);
  }
  if (end_time_mysql !== undefined) {
    updates.push("`end_date` = ?");
    params.push(end_time_mysql);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: "No fields provided for update." });
  }

  params.push(address_id); // This is appoint_id for WHERE clause
  const query1 = `UPDATE appointment SET ${updates.join(
    ", "
  )} WHERE appoint_id = ?;`;

  try {
    await switchToEmployeeDB(emp_id);
    await q(query1, params);
    res.json({ message: "Appointment edited successfully." });
  } catch (e) {
    console.error("Error in /editappoint:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to edit appointment." });
  }
});

// ThaiBox-------------------------------------------------------------------------------------------------------------------
app.get("/gentrack", async (req, res) => {
  const { type, emp_id } = req.query;
  if (!type) {
    return res.status(400).json({ error: "Tracking type prefix is required." });
  }
  const typelike = type + "-%"; 
  const query =
    "SELECT tracking_number FROM `packages` WHERE `tracking_number` LIKE ? ORDER BY CAST(SUBSTRING_INDEX(tracking_number, '-', -1) AS UNSIGNED) DESC LIMIT 1;";
  try {
    await switchToEmployeeDB(emp_id);
    const results = await q(query, [typelike]);
    res.json(results); 
  } catch (e) {
    console.error("Error in /gentrack:", e.msg || e.message, e.err || "");
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Failed to generate tracking number." });
  }
});

// User-------------------------------------------------------------------------------------------------------------------
app.post("/editsendaddr", async (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
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
    doc_url, // This should be an S3 URL or similar
    emp_id,
  } = req.body;

  if (!emp_id) return res.status(400).json({ error: "emp_id is required" });
  if (!customer_id)
    return res.status(400).json({ error: "customer_id is required" });

  try {
    await switchToEmployeeDB(emp_id);

    // Fetch current doc_url to delete from S3 if it changes
    let oldDocUrl = null;
    if (doc_url !== undefined) { // If a new doc_url is provided or it's being cleared
        const [currentCustomer] = await q("SELECT doc_url FROM customers WHERE customer_id = ?", [customer_id]);
        if (currentCustomer && currentCustomer.doc_url) {
            oldDocUrl = currentCustomer.doc_url;
        }
    }
    
    let sql =
      "UPDATE customers SET customer_name = ?, address = ?, city = ?, state = ?, country = ?, zipcode = ?, phone = ?";
    const params = [
      customer_name || null,
      address || null,
      city || null,
      state || null,
      country,
      zipcode || null,
      phone || null,
    ];

    if (doc_type !== undefined && doc_url !== undefined) {
      sql += ", doc_type = ?, doc_url = ?";
      params.push(doc_type, doc_url || null); // Allow clearing doc_url by passing null/empty
    } else if (doc_url !== undefined) { // If only doc_url is sent (e.g. to clear it, assuming doc_type remains or is cleared separately)
      sql += ", doc_url = ?";
      params.push(doc_url || null);
    }

    sql += " WHERE customer_id = ?";
    params.push(customer_id);

    await q(sql, params);

    // If doc_url was updated and oldDocUrl existed and is different
    if (doc_url !== undefined && oldDocUrl && oldDocUrl !== (doc_url || null) ) {
        const s3Key = extractS3KeyFromUrl(oldDocUrl);
        if (s3Key) {
            await deleteS3Object(s3Key);
            console.log(`Old S3 document ${s3Key} deleted for customer ${customer_id}`);
        }
    }

    return res.json({
      success: true,
      message: "Customer address and document (if any) updated successfully.",
    });
  } catch (e) {
    console.error("Error in /editsendaddr:", e.msg || e.message, e.err || "", e.stack);
    return res
      .status(e.status || 500)
      .json({ error: e.msg || "Internal server error while updating address" });
  }
});


// Setting-------------------------------------------------------------------------------------------------------------------

const getCompanyFilePath = (companyName, fileName) => {
  // This check is now at the top of the file
  // if (!process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  //   console.error("RAILWAY_VOLUME_MOUNT_PATH is not set.");
  //   throw new Error("Server configuration error: Volume mount path missing.");
  // }
  if (
    !companyName ||
    typeof companyName !== "string" ||
    companyName.trim() === ""
  ) {
    throw new Error("Invalid company name for file path generation.");
  }
  const dirPath = path.join(
    process.env.RAILWAY_VOLUME_MOUNT_PATH, // This must be defined
    companyName.trim()
  );
  const filePath = path.join(dirPath, fileName);
  return { dirPath, filePath };
};

const readOrCreateJsonFile = (filePath, dirPath, defaultData = {}) => {
  try {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    if (!fs.existsSync(filePath))
      fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data);
  } catch (fsErr) {
    console.error(`Filesystem error for ${filePath}:`, fsErr.message);
    throw new Error(
      `Failed to load or create ${path.basename(filePath)} information`
    );
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

  companydb.query(
    "SELECT company_name FROM employee WHERE emp_id = ?",
    [emp_id],
    (err, results) => {
      if (err) {
        console.error("DB error in /company_info:", err.message);
        return res.status(500).json({ error: "Database error" });
      }
      const row = firstRowOr404(
        res,
        results,
        "Employee not found for company_info."
      );
      if (!row) return;
      if (!row.company_name)
        return res
          .status(500)
          .json({ error: "Company name not found for employee." });

      try {
        const { dirPath, filePath } = getCompanyFilePath(
          row.company_name,
          "company_info.json"
        );
        const data = readOrCreateJsonFile(filePath, dirPath, {});
        res.json(data);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  );
});

app.get("/dropdown", (req, res) => {
  const { emp_id } = req.query;
  if (!emp_id) return res.status(400).json({ error: "emp_id is required" });
  const emptyData = { channels: [], categories: [], levels: [] };

  companydb.query(
    "SELECT company_name FROM employee WHERE emp_id = ?",
    [emp_id],
    (err, results) => {
      if (err) {
        console.error("DB error in /dropdown:", err.message);
        return res.status(500).json({ error: "Failed to fetch employee data" });
      }
      const row = firstRowOr404(
        res,
        results,
        "Employee not found for dropdown settings."
      );
      if (!row) return;
      if (!row.company_name)
        return res
          .status(500)
          .json({ error: "Company name not found for employee." });

      try {
        const { dirPath, filePath } = getCompanyFilePath(
          row.company_name,
          "dropdown.json"
        );
        const data = readOrCreateJsonFile(filePath, dirPath, emptyData);
        res.json(data);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  );
});

app.post("/editdropdown", (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { channels, categories, levels, emp_id } = req.body; 

  if (
    !emp_id ||
    !Array.isArray(channels) ||
    !Array.isArray(categories) ||
    !Array.isArray(levels)
  ) {
    return res.status(400).json({
      error: "emp_id and arrays for channels, categories, levels are required.",
    });
  }
  // Sanitize: ensure names are strings and unique, structure is [{name: "value"}]
  const sanitizeArrayOfObjects = (arr) => {
    if (!Array.isArray(arr)) return [];
    const uniqueNames = new Set();
    return arr
      .filter(item => item && typeof item.name === 'string' && item.name.trim() !== '')
      .map(item => ({ name: item.name.trim() }))
      .filter(item => {
        if (uniqueNames.has(item.name)) {
          return false;
        }
        uniqueNames.add(item.name);
        return true;
      });
  };


  const processedData = {
    channels: sanitizeArrayOfObjects(channels),
    categories: sanitizeArrayOfObjects(categories),
    levels: sanitizeArrayOfObjects(levels),
  };

  companydb.query(
    "SELECT company_name FROM employee WHERE emp_id = ?",
    [emp_id],
    (err, results) => {
      if (err) {
        console.error("DB error in /editdropdown:", err.message);
        return res.status(500).json({ error: "Failed to fetch employee data" });
      }
      const row = firstRowOr404(
        res,
        results,
        "Employee not found for dropdown settings update."
      );
      if (!row) return;
      if (!row.company_name)
        return res
          .status(500)
          .json({ error: "Company name not found for employee." });

      try {
        const { dirPath, filePath } = getCompanyFilePath(
          row.company_name,
          "dropdown.json"
        );
        writeJsonFile(filePath, dirPath, processedData);
        res.json({ message: "Dropdown settings updated successfully." });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    }
  );
});

const createSettingsRoute = (settingName, defaultData = {}) => {
  app.get(`/${settingName}`, (req, res) => {
    const { emp_id } = req.query;
    if (!emp_id) return res.status(400).json({ error: "emp_id is required" });

    companydb.query(
      "SELECT company_name FROM employee WHERE emp_id = ?",
      [emp_id],
      (err, results) => {
        if (err) {
          console.error(`DB error in /${settingName}:`, err.message);
          return res.status(500).json({ error: "Database error" });
        }
        const row = firstRowOr404(
          res,
          results,
          `Employee not found for ${settingName} settings.`
        );
        if (!row) return;
        if (!row.company_name)
          return res
            .status(500)
            .json({ error: `Company name not found for ${settingName}.` });

        try {
          const { dirPath, filePath } = getCompanyFilePath(
            row.company_name,
            `${settingName}.json`
          );
          const data = readOrCreateJsonFile(filePath, dirPath, defaultData);
          res.json(data);
        } catch (e) {
          res.status(500).json({ error: e.message });
        }
      }
    );
  });

  app.post(`/edit${settingName}`, (req, res) => {
    if (!req.body)
      return res.status(400).json({ error: "Request body is missing" });
    const { emp_id } = req.body; 
    let newData = req.body; // Default to full body

    // Specific handling for different settings if structure varies
    if (settingName === "price" && req.body.updatedPricing) {
        newData = req.body.updatedPricing;
    } else if (settingName === "promotion" && req.body.updatedPromotions) {
        newData = req.body.updatedPromotions;
    } else if (settingName === "company_info" && req.body.formData) {
        newData = req.body.formData;
    } else if (settingName === "warehouse") { // For 'warehouse', data might be the whole body excluding emp_id
        const { emp_id: _, ...warehouseData } = req.body;
        newData = warehouseData;
    } else { // For other settings, or if specific keys aren't present, assume relevant data is top-level excluding emp_id
        const { emp_id: _, ...restOfData } = req.body;
        newData = restOfData;
    }


    if (!emp_id || newData === undefined || Object.keys(newData).length === 0) // Also check if newData is empty
      return res
        .status(400)
        .json({ error: `emp_id and data for ${settingName} are required.` });

    if (typeof newData !== "object" || newData === null) {
      return res
        .status(400)
        .json({ error: `Data for ${settingName} must be an object.` });
    }

    companydb.query(
      "SELECT company_name FROM employee WHERE emp_id = ?",
      [emp_id],
      (err, results) => {
        if (err) {
          console.error(`DB error in /edit${settingName}:`, err.message);
          return res.status(500).json({ error: "Database error" });
        }
        const row = firstRowOr404(
          res,
          results,
          `Employee not found for ${settingName} settings update.`
        );
        if (!row) return;
        if (!row.company_name)
          return res
            .status(500)
            .json({ error: `Company name not found for ${settingName}.` });

        try {
          const { dirPath, filePath } = getCompanyFilePath(
            row.company_name,
            `${settingName}.json`
          );
          
          // If logoUrl is part of company_info and it changed, delete old S3 logo
          if (settingName === "company_info" && newData.logoUrl !== undefined) {
            const currentData = readOrCreateJsonFile(filePath, dirPath, defaultData);
            if (currentData.logoUrl && currentData.logoUrl !== newData.logoUrl) {
              const s3Key = extractS3KeyFromUrl(currentData.logoUrl);
              if (s3Key) {
                deleteS3Object(s3Key).catch(s3Err => console.error("Failed to delete old S3 logo:", s3Err));
              }
            }
          }
          
          writeJsonFile(filePath, dirPath, newData); // Save the processed newData
          res.json({
            message: `${settingName} settings updated successfully.`,
          });
        } catch (e) {
          res.status(500).json({ error: e.message });
        }
      }
    );
  });
};

createSettingsRoute("price", []); // Default to empty array for price
createSettingsRoute("promotion", []); // Default to empty array for promotion
createSettingsRoute("warehouse", {}); // Default to empty object for warehouse
createSettingsRoute("company_info", {}); // Default to empty object for company_info

app.get("/employee", (req, res) => {
  const { emp_id } = req.query; 
  if (!emp_id)
    return res.status(400).json({ error: "Requesting emp_id is required." });

  companydb.query(
    "SELECT company_name FROM `employee` WHERE `emp_id` = ?",
    [emp_id],
    (err, results) => {
      if (err) {
        console.error("DB error in /employee (step 1):", err.message);
        return res.status(500).json({ error: "Failed to fetch data" });
      }
      const row = firstRowOr404(res, results, "Requesting employee not found.");
      if (!row) return;
      if (!row.company_name)
        return res
          .status(500)
          .json({ error: "Company name not found for requesting employee." });

      companydb.query(
        "SELECT emp_id, username, emp_name, role, emp_date, eimg FROM `employee` WHERE `company_name` = ?",
        [row.company_name],
        (err, companyEmployees) => {
          if (err) {
            console.error("DB error in /employee (step 2):", err.message);
            return res
              .status(500)
              .json({ error: "Failed to fetch company employees" });
          }
          res.json(companyEmployees);
        }
      );
    }
  );
});

app.get("/employeeinfo", (req, res) => {
  const { id } = req.query; 
  if (!id)
    return res
      .status(400)
      .json({ error: "Encrypted employee ID (id) is required." });
  const decryptedId = decryptEmpId(id); // Middleware already decrypts req.query.emp_id, this is for path/param `id`
  if (!decryptedId)
    return res
      .status(400)
      .json({ error: "Invalid or undecryptable employee ID." });

  companydb.query(
    "SELECT emp_id, username, emp_name, role, emp_date, eimg FROM `employee` WHERE `emp_id` = ?;",
    [decryptedId],
    (err, results) => {
      if (err) {
        console.error("DB error in /employeeinfo:", err.message);
        return res.status(500).json({ error: "Failed to fetch data" });
      }
      const row = firstRowOr404(res, results, "Employee info not found.");
      if (!row) return;
      res.json(row); 
    }
  );
});

app.post("/addemployee", (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const {
    emp_name,
    username,
    role,
    password,
    emp_date, // This is the hired date
    eimg, // This is the S3 URL for employee image
    emp_id: requesting_emp_id, // This is the emp_id of the admin/owner making the request
  } = req.body; 

  if (!emp_name || !username || !role || !password || !requesting_emp_id) {
    return res
      .status(400)
      .json({ error: "Missing required fields for adding employee." });
  }

  companydb.query(
    "SELECT company_name, emp_database, emp_datapass FROM `employee` WHERE `emp_id` = ?",
    [requesting_emp_id],
    (err, results) => {
      if (err) {
        console.error("DB error in /addemployee (step 1):", err.message);
        return res
          .status(500)
          .json({ error: "Failed to fetch requesting employee data" });
      }
      const row = firstRowOr404(res, results, "Requesting employee not found.");
      if (!row) return;
      if (!row.company_name || !row.emp_database || !row.emp_datapass) {
        return res.status(500).json({
          error:
            "Configuration error: Requesting employee's company details missing.",
        });
      }

      const query1 =
        "INSERT INTO `employee` (`username`, `emp_name`, `password`, `emp_database`, `emp_datapass`, `company_name`, `role`, `eimg`, `emp_date`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);";
      companydb.query(
        query1,
        [
          username,
          emp_name,
          password, 
          row.emp_database,
          row.emp_datapass,
          row.company_name,
          role,
          eimg || null, // Use provided eimg (S3 URL) or null
          emp_date || new Date(),
        ],
        (err, insertResult) => {
          if (err) {
            console.error("DB error in /addemployee (step 2):", err.message);
            if (err.code === 'ER_DUP_ENTRY') {
                 return res.status(409).json({ error: "Username already exists." });
            }
            return res
              .status(500)
              .json({ error: "Failed to add new employee" });
          }
          res.json({
            message: "Employee added successfully.",
            empIdGeneratedByDB: insertResult.insertId, // This is the auto-incremented emp_id if your table uses it
          });
        }
      );
    }
  );
});

app.post("/editemployee", (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { emp_id, emp_name, password, role, username, eimg } = req.body; 

  if (!emp_id) // emp_id here is the ID of the employee being edited (already decrypted if it came encrypted)
    return res
      .status(400)
      .json({ error: "emp_id of employee to edit is required." });
  
  const updates = [];
  const params = [];
  if (username !== undefined) {
    updates.push("`username` = ?");
    params.push(username);
  }
  if (emp_name !== undefined) {
    updates.push("`emp_name` = ?");
    params.push(emp_name);
  }
  if (password !== undefined && password !== "") { // Only update password if provided and not empty
    updates.push("`password` = ?");
    params.push(password);
  } 
  if (role !== undefined) {
    updates.push("`role` = ?");
    params.push(role);
  }
  if (eimg !== undefined) { // Allow updating or clearing eimg
    updates.push("`eimg` = ?");
    params.push(eimg || null);
  }


  if (updates.length === 0)
    return res.status(400).json({ error: "No fields provided for update." });

  params.push(emp_id); // Add emp_id for the WHERE clause
  const query = `UPDATE employee SET ${updates.join(", ")} WHERE emp_id = ?;`;

  // Fetch old eimg for S3 deletion if it's being changed
  companydb.query("SELECT eimg FROM employee WHERE emp_id = ?", [emp_id], (fetchErr, oldEmployee) => {
    if (fetchErr) {
        console.error("DB error fetching old employee eimg:", fetchErr.message);
        return res.status(500).json({ error: "Failed to prepare employee update." });
    }
    if (!oldEmployee || oldEmployee.length === 0) {
        return res.status(404).json({ error: "Employee to edit not found." });
    }
    const oldEimgUrl = oldEmployee[0].eimg;

    companydb.query(query, params, (err, results) => {
        if (err) {
          console.error("DB error in /editemployee:", err.message);
            if (err.code === 'ER_DUP_ENTRY' && err.message.includes('username')) {
                return res.status(409).json({ error: "Username already exists." });
            }
          return res.status(500).json({ error: "Failed to update employee" });
        }
        if (results.affectedRows === 0)
          return res
            .status(404) // Or 304 if no changes were made but employee exists
            .json({ error: "Employee not found or no changes made." });

        // If eimg was updated and old eimg existed and is different
        if (eimg !== undefined && oldEimgUrl && oldEimgUrl !== (eimg || null)) {
            const s3Key = extractS3KeyFromUrl(oldEimgUrl);
            if (s3Key) {
                deleteS3Object(s3Key).catch(s3Err => console.error("Failed to delete old S3 employee image:", s3Err));
            }
        }
        res.json({ message: "Employee updated successfully." });
      });
  });
});


app.post("/deleteemployee", (req, res) => {
  if (!req.body)
    return res.status(400).json({ error: "Request body is missing" });
  const { emp_id } = req.body; // emp_id of employee to be deleted

  if (!emp_id)
    return res
      .status(400)
      .json({ error: "emp_id of employee to delete is required." });

  // Fetch employee details to get eimg for S3 deletion
  companydb.query("SELECT eimg, role FROM employee WHERE emp_id = ?", [emp_id], (fetchErr, results) => {
    if (fetchErr) {
        console.error("DB error fetching employee for deletion:", fetchErr.message);
        return res.status(500).json({ error: "Failed to fetch employee details for deletion." });
    }
    if (!results || results.length === 0) {
        return res.status(404).json({ error: "Employee not found." });
    }
    const employeeToDelete = results[0];

    if (employeeToDelete.role === 'owner') {
        return res.status(403).json({ error: "Owner role cannot be deleted." });
    }

    const queryDelete = "DELETE FROM `employee` WHERE `emp_id` = ?;";
    companydb.query(queryDelete, [emp_id], (deleteErr, deleteResults) => {
      if (deleteErr) {
        console.error("DB error in /deleteemployee:", deleteErr.message);
        return res.status(500).json({ error: "Failed to delete employee" });
      }
      if (deleteResults.affectedRows === 0) {
        // This case should ideally be caught by the fetch above, but as a safeguard:
        return res.status(404).json({
          error: "Employee not found or already deleted.",
        });
      }

      // If employee had an image, delete it from S3
      if (employeeToDelete.eimg) {
        const s3Key = extractS3KeyFromUrl(employeeToDelete.eimg);
        if (s3Key) {
          deleteS3Object(s3Key).catch(s3Err => console.error("Failed to delete S3 employee image:", s3Err));
        }
      }
      res.json({ message: "Employee and associated S3 image (if any) deleted successfully." });
    });
  });
});


//-------------------------------------------Local Management (Multer for local disk)------------------------------------------
// THESE ARE PROBLEMATIC ON RAILWAY'S EPHEMERAL FILESYSTEM IF PERSISTENCE IS NEEDED.
// Strongly recommend using S3 for all uploads.
// If you *must* use local storage, ensure a Volume is attached in Railway.

const getLocalUploadPath = (subfolder) => {
  if (!process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    console.error(
      "RAILWAY_VOLUME_MOUNT_PATH is not set. Local uploads will fail or be lost."
    );
    // Depending on how critical local uploads are, you might throw an error here or return null
    // and let the calling function handle it. For now, returning null.
    return null;
  }
  const baseUploadDir = path.join(
    process.env.RAILWAY_VOLUME_MOUNT_PATH,
    "uploads"
  );
  const targetDir = path.join(baseUploadDir, subfolder);
  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    return targetDir;
  } catch (e) {
    console.error(`Failed to create directory ${targetDir}:`, e.message);
    return null; // Failed to create/ensure directory
  }
};

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = getLocalUploadPath("img");
    if (!uploadDir) {
      // If getLocalUploadPath returns null, it means RAILWAY_VOLUME_MOUNT_PATH is not set
      // or directory creation failed.
      return cb(
        new Error(
          "Image upload directory is not configured or accessible. Check RAILWAY_VOLUME_MOUNT_PATH."
        )
      );
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const safeOriginalName = path
      .basename(file.originalname)
      .replace(/[^a-zA-Z0-9._-]/g, "_");
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + safeOriginalName); // CORRECTED TYPO
  },
});
const uploadImage = multer({
  storage: imageStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed!"), false);
    }
  },
});

app.post("/uploadLogo", uploadImage.single("logo"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "No file uploaded or invalid file type.",
    });
  }
  // Return a relative path or just filename if served via express.static
  // For Railway, S3 is preferred. This local file might not be accessible publicly.
  res.status(200).json({
    success: true,
    message: "Logo uploaded successfully (locally)",
    fileName: req.file.filename,
    // To make it accessible if served via express.static:
    // localUrl: `/uploads/img/${req.file.filename}`
  });
});

app.post("/uploadSlip", uploadImage.single("slip"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "No slip file uploaded or invalid file type.",
    });
  }
  res.status(200).json({
    success: true,
    message: "Slip uploaded successfully (locally)",
    fileName: req.file.filename,
    // localUrl: `/uploads/img/${req.file.filename}`
  });
});

const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = getLocalUploadPath("doc");
    if (!uploadDir) {
      return cb(
        new Error(
          "Document upload directory is not configured or accessible. Check RAILWAY_VOLUME_MOUNT_PATH."
        )
      );
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const safeOriginalName = path
      .basename(file.originalname)
      .replace(/[^a-zA-Z0-9._-]/g, "_");
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + safeOriginalName); // CORRECTED TYPO
  },
});
const uploadDocument = multer({
  storage: documentStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.post("/uploadDocument", uploadDocument.single("document"), (req, res) => {
  if (!req.file) {
    return res
      .status(400)
      .json({ success: false, message: "No document file uploaded." });
  }
  res.status(200).json({
    success: true,
    message: "Document uploaded successfully (locally)",
    fileName: req.file.filename,
    // localUrl: `/uploads/doc/${req.file.filename}`
  });
});

// Static serving for locally uploaded images/docs
// This will only work if RAILWAY_VOLUME_MOUNT_PATH is set and a volume is attached.
if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  const localUploadsBaseDir = path.join(
    process.env.RAILWAY_VOLUME_MOUNT_PATH,
    "uploads"
  );
  if (!fs.existsSync(localUploadsBaseDir)) {
    try {
      fs.mkdirSync(localUploadsBaseDir, { recursive: true });
    } catch (e) {
      console.warn(`Could not create base local uploads directory ${localUploadsBaseDir}: ${e.message}. Static serving might fail.`);
    }
  }
  app.use("/uploads", express.static(localUploadsBaseDir));
  console.log(
    `Serving local uploads from ${localUploadsBaseDir} at /uploads (if volume is attached and path is valid)`
  );
} else {
  console.warn(
    "RAILWAY_VOLUME_MOUNT_PATH not set. Static serving for local uploads is disabled."
  );
}

//--------------------------------------------------- S3 IMAGE UPLOAD (Preferred for Cloud) ---------------------------------------------------

const createS3UploadHandler = (fieldName, s3SubFolder) => {
  return async (req, res) => {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: `No file uploaded (field '${fieldName}')` });
    }
    const { originalname, buffer, mimetype } = req.file; // Added mimetype

    const empId = req.query.emp_id || (req.body && req.body.emp_id);
    if (!empId) {
      return res
        .status(400)
        .json({ error: "Invalid or missing emp_id (decrypted)" });
    }
    if (!process.env.AWS_BUCKET || !process.env.AWS_REGION) { // Also check AWS_REGION
      console.error("AWS_BUCKET or AWS_REGION environment variable is not set.");
      return res
        .status(500)
        .json({ error: "Server configuration error for S3 upload." });
    }

    try {
      const rows = await new Promise((resolve, reject) => {
        companydb.query(
          "SELECT emp_database FROM employee WHERE emp_id = ?",
          [empId],
          (err, results) => (err ? reject(err) : resolve(results))
        );
      });
      if (!rows || rows.length === 0) {
        return res
          .status(404)
          .json({ error: `Employee not found for emp_id: ${empId}` });
      }
      const companyFolder = rows[0].emp_database;
      if (!companyFolder) {
        return res.status(500).json({
          error: `Configuration error: emp_database not found for employee ${empId}`,
        });
      }
      
      let processedBuffer = buffer;
      let contentType = mimetype;
      let fileExtension = path.extname(originalname).toLowerCase();

      // Convert to WebP only if it's an image type that Sharp supports for outputting WebP
      // And not already a WebP
      if (mimetype.startsWith('image/') && mimetype !== 'image/webp' && mimetype !== 'image/gif' /*Sharp might have issues with animated gif to webp*/) {
          try {
            processedBuffer = await sharp(buffer).webp({ quality: 80 }).toBuffer();
            contentType = "image/webp";
            fileExtension = ".webp";
          } catch (sharpError) {
            console.warn(`Sharp conversion to WebP failed for ${originalname}, uploading as original: ${sharpError.message}`);
            // Fallback to original buffer and contentType if sharp fails
            processedBuffer = buffer;
            contentType = mimetype; // Keep original
          }
      }


      let key;
      const baseName = path
        .basename(originalname, path.extname(originalname))
        .replace(/[^a-zA-Z0-9_-]/g, "_");
      const timestamp = Date.now();

      // Use clientFileName if provided and sanitized, otherwise use originalname
      let desiredBaseName = baseName;
      if (req.body && req.body.fileName) {
        desiredBaseName = path
          .basename(req.body.fileName, path.extname(req.body.fileName)) // Remove extension from client name
          .replace(/[^a-zA-Z0-9_-]/g, "_");
      }
      
      key = `${companyFolder}/public/${s3SubFolder}/${desiredBaseName}_${timestamp}${fileExtension}`;


      const cmd = new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET,
        Key: key,
        Body: processedBuffer, // Use processed buffer
        ContentType: contentType, // Use determined content type
      });
      
      // For PUT, presigned URL is for uploading, not for public access after upload.
      // await s3.send(cmd); // Direct upload without pre-signed URL for PUT by server

      // If you want client to upload directly via presigned URL (more complex setup):
      // const presignedPutUrl = await getSignedUrl(s3, cmd, { expiresIn: 300 });
      // return res.json({ presignedUrl: presignedPutUrl, key });
      // For server-side upload (simpler for this flow):
      await s3.send(cmd);


      const publicUrl = `https://${process.env.AWS_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

      return res.json({ publicUrl, key }); // Return key for easier deletion/reference
    } catch (err) {
      console.error(
        `Error in S3 upload handler for ${fieldName}:`,
        err.message,
        err.stack
      );
      return res.status(500).json({
        error: err.message || "Internal server error during S3 upload",
      });
    }
  };
};

app.post(
  "/uploadPackageImage",
  uploadMemory.single("packageImage"),
  createS3UploadHandler("packageImage", "package_images") // Changed subfolder
);
app.post(
  "/uploadItemImage",
  uploadMemory.single("itemImage"),
  createS3UploadHandler("itemImage", "item_images") // Changed subfolder
);
app.post(
  "/uploadVerifyImg",
  uploadMemory.single("verifyImg"),
  createS3UploadHandler("verifyImg", "verify_images") // Changed subfolder
);
app.post( // New route for general S3 logo uploads
    "/uploadS3Logo",
    uploadMemory.single("logoFile"), // field name for the file
    createS3UploadHandler("logoFile", "logos")
);
app.post( // New route for general S3 slip uploads
    "/uploadS3Slip",
    uploadMemory.single("slipFile"),
    createS3UploadHandler("slipFile", "slips")
);
app.post( // New route for general S3 document uploads
    "/uploadS3Document",
    uploadMemory.single("documentFile"),
    createS3UploadHandler("documentFile", "documents")
);
app.post( // New route for employee image uploads to S3
    "/uploadEmployeeImage",
    uploadMemory.single("employeeImageFile"),
    createS3UploadHandler("employeeImageFile", "employee_images")
);


// DELETING LOCAL FILES (These routes are problematic on ephemeral filesystems like Railway)
// Consider if these are still needed or if S3 deletion is primary.
// If keeping, ensure photo_url is just the filename for local files.
// For S3, you'd call deleteS3Object directly from the business logic routes (e.g., deleteitem, deletepackage).

app.post("/deleteLocalFile", (req, res) => { // Generic local file deleter
    if (!req.body || typeof req.body.filePath !== 'string') { // Expecting a relative path like 'img/filename.jpg'
        return res.status(400).json({ success: false, message: "filePath (relative string like 'img/filename.jpg') is required." });
    }
    const { filePath: relativeFilePath } = req.body;

    if (!process.env.RAILWAY_VOLUME_MOUNT_PATH) {
        return res.status(500).json({ success: false, message: "Local storage volume not configured." });
    }

    // Construct full path carefully, sanitize to prevent path traversal
    const baseUploadsDir = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "uploads");
    const fullFilePath = path.join(baseUploadsDir, path.normalize(relativeFilePath));

    // Security check: ensure the resolved path is still within the intended uploads directory
    if (!fullFilePath.startsWith(baseUploadsDir)) {
        return res.status(400).json({ success: false, message: "Invalid file path." });
    }

    try {
        if (fs.existsSync(fullFilePath)) {
            fs.unlinkSync(fullFilePath);
            console.log(`Locally deleted file: ${fullFilePath}`);
            res.status(200).json({ success: true, message: `Local file ${relativeFilePath} deleted successfully.` });
        } else {
            res.status(404).json({ success: false, message: `Local file ${relativeFilePath} not found.` });
        }
    } catch (error) {
        console.error("Error handling local deleteLocalFile request:", error.message);
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
    await switchToEmployeeDB(emp_id); 
    const results = await q(
      `SELECT c.customer_id, c.contact, c.type, c.level, c.note
       FROM customers c
       INNER JOIN packages p ON c.customer_id = p.customer_id
       WHERE p.tracking_number = ?`,
      [trackingNumber]
    );
    if (results.length === 0) {
      return res
        .status(404)
        .json({ error: "No customer found for this tracking number." });
    }
    res.json(results); 
  } catch (e) {
    console.error(
      "Error in /searchByTracking:",
      e.msg || e.message,
      e.err || ""
    );
    res
      .status(e.status || 500)
      .json({ error: e.msg || "Error fetching customer by tracking number" });
  }
});

// Global error handler (simple version)
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message, err.stack); // Log stack for debugging
  const errorMessage =
    process.env.NODE_ENV === "production"
      ? "An unexpected error occurred."
      : err.message;
  res.status(err.status || 500).json({
    error: errorMessage,
    // Optionally include stack in dev but not prod
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
});

const PORT = process.env.PORT || 3001;

function startServerIfReady() {
  if (dbConnected && companyDbConnected) {
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
        console.log(
          `Persistent volume expected at: ${process.env.RAILWAY_VOLUME_MOUNT_PATH}`
        );
      } else {
        console.warn(
          "RAILWAY_VOLUME_MOUNT_PATH is not set. File system operations needing persistence will fail or use ephemeral storage."
        );
      }
    });
  }
}