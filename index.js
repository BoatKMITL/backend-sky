const express = require('express');
const mysql = require('mysql');
const cors = require('cors');
const path = require("path");
const fs = require("fs");
const app = express();

app.use(cors());
app.use(express.json());

const db = mysql.createConnection({
    host: "th257.ruk-com.in.th",
    user: "sharebil_sky4you",
    password: "LN5avYu2KUwGDR6Ytreg",
    port: "3306",
    database: "sharebil_sky4you",
});

const companydb = mysql.createConnection({
    host: "th257.ruk-com.in.th",
    user: "sharebil_sky4you",
    password: "LN5avYu2KUwGDR6Ytreg",
    port: "3306",
    database: "sharebil_sky4you",
});
// Login-------------------------------------------------------------------------------------------------------------------
app.post('/login', (req, res) => {
    if (req.body.emp_id !== undefined) {
        const emp_id = req.body.emp_id;
        const query = "SELECT * FROM `employee` WHERE `emp_id` = ?";
        companydb.query(query, [emp_id], (err, results) => {
            if (err) {
                console.error("Error fetching data:", err.message);
                res.status(500).json({ error: "Failed to fetch data" });
            } else {
                const newDatabase = results[0].emp_database; // Example of dynamic DB
                const newUser = results[0].emp_database; // Example of dynamic user
                const newPassword = results[0].emp_datapass; // Example of dynamic password
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
                        res.json(results);
                    }
                );
            }
        });
    } else {
        const username = req.body.username;
        const password = req.body.password;
        const query = "SELECT * FROM `employee` WHERE `username` = ? AND `password` = ?";
        companydb.query(query, [username, password], (err, results) => {
            if (err) {
                console.error("Error fetching data:", err.message);
                res.status(500).json({ error: "Failed to fetch data" });
            } else {
                const newDatabase = results[0].emp_database; // Example of dynamic DB
                const newUser = results[0].emp_database; // Example of dynamic user
                const newPassword = results[0].emp_datapass; // Example of dynamic password
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
                        res.json(results);
                    }
                );
            }
        });
    }
});

app.post('/logout', (req, res) => {
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
app.get('/customers', (req, res) => {
    const query = "SELECT c.*, COUNT(p.tracking_number) AS package_count FROM customers AS c LEFT JOIN packages AS p ON c.customer_id = p.customer_id WHERE NOT EXISTS (SELECT 1 FROM items AS i WHERE i.tracking_number = p.tracking_number GROUP BY i.tracking_number HAVING MIN(i.item_status) = 1 AND MAX(i.item_status) = 1) GROUP BY c.customer_id ORDER BY c.customer_date DESC;";
    db.query(query, (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.json(results);
        }
    });
});

app.post('/deleteCustomer', (req, res) => {
    const customerId = req.body.customer_id;

    if (!customerId) {
        return res.status(400).json({ success: false, message: "Customer ID is required" });
    }

    // Begin a transaction
    db.beginTransaction((err) => {
        if (err) {
            console.error("Error starting transaction:", err.message);
            return res.status(500).json({ success: false, message: "Failed to start transaction" });
        }

        // Define queries
        const queries = [
            {
                query: "DELETE FROM subbox_item WHERE subbox_id IN (SELECT subbox_id FROM subbox WHERE box_id IN (SELECT box_id FROM box WHERE customer_id = ?))",
                params: [customerId]
            },
            {
                query: "DELETE FROM subbox WHERE box_id IN (SELECT box_id FROM box WHERE customer_id = ?)",
                params: [customerId]
            },
            {
                query: "DELETE FROM slip WHERE box_id IN (SELECT box_id FROM box WHERE customer_id = ?)",
                params: [customerId]
            },
            {
                query: "DELETE FROM items WHERE tracking_number IN (SELECT tracking_number FROM packages WHERE customer_id = ?)",
                params: [customerId]
            },
            {
                query: "DELETE FROM packages WHERE customer_id = ?",
                params: [customerId]
            },
            {
                query: "DELETE FROM box WHERE customer_id = ?",
                params: [customerId]
            },
            {
                query: "DELETE FROM appointment WHERE customer_id = ?",
                params: [customerId]
            },
            {
                query: "DELETE FROM addresses WHERE customer_id = ?",
                params: [customerId]
            },
            {
                query: "DELETE FROM customers WHERE customer_id = ?",
                params: [customerId]
            }
        ];

        // Execute each query in sequence
        let promiseChain = Promise.resolve();
        queries.forEach(({ query, params }) => {
            promiseChain = promiseChain.then(() => {
                return new Promise((resolve, reject) => {
                    db.query(query, params, (err) => {
                        if (err) {
                            return reject(err);
                        }
                        resolve();
                    });
                });
            });
        });

        // Commit or rollback transaction based on success or failure
        promiseChain
            .then(() => {
                db.commit((err) => {
                    if (err) {
                        console.error("Error committing transaction:", err.message);
                        return db.rollback(() => {
                            res.status(500).json({ success: false, message: "Failed to commit transaction" });
                        });
                    }
                    res.status(200).json({ success: true, message: "Customer and associated data deleted successfully" });
                });
            })
            .catch((err) => {
                console.error("Error executing queries:", err.message);
                db.rollback(() => {
                    res.status(500).json({ success: false, message: "Failed to delete customer and associated data" });
                });
            });
    });
});
// Customer-------------------------------------------------------------------------------------------------------------------
app.get('/customersDetails', (req, res) => {
    const { id } = req.query;
    const query = "SELECT * FROM customers WHERE customer_id = ?;";
    db.query(query, [id], (err, customerResults) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } res.json(customerResults);
    });
});

app.get('/addressesinfo', (req, res) => {
    const { id } = req.query;
    const query2 = "SELECT * FROM addresses WHERE address_id = ?;";
    db.query(query2, [id], (err, addressesResults) => {
        if (err) {
            console.error("Error in second query:", err.message);
            return res.status(500).json({ error: "Failed to fetch data from second query" });
        } else {
            res.json(addressesResults);
        }
    });
});

app.get('/customersaddresses', (req, res) => {
    const { id } = req.query;
    const query2 = "SELECT * FROM addresses WHERE customer_id = ?;";
    db.query(query2, [id], (err, addressesResults) => {
        if (err) {
            console.error("Error in second query:", err.message);
            return res.status(500).json({ error: "Failed to fetch data from second query" });
        } else {
            res.json(addressesResults);
        }
    });
});

app.get('/customerspackages', (req, res) => {
    const { id } = req.query;
    const processedId = id === undefined ? null : id;
    const query3 = `
        SELECT 
            p.*,
            COALESCE(SUM(CASE WHEN i.item_status = 0 THEN 1 ELSE 0 END), 0) AS sum0,
            COALESCE(SUM(CASE WHEN i.item_status = 1 THEN 1 ELSE 0 END), 0) AS sum1
        FROM 
            packages p
        LEFT JOIN 
            items i 
        ON 
            p.tracking_number = i.tracking_number
        WHERE 
            ${processedId === null ? "p.customer_id IS NULL" : "p.customer_id = ?"}
        GROUP BY 
            p.tracking_number;
    `;
    const params = processedId === null ? [] : [processedId];
    db.query(query3, params, (err, packagesResults) => {
        if (err) {
            console.error("Error in third query:", err.message);
            return res.status(500).json({ error: "Failed to fetch data from third query" });
        } else {
            res.json(packagesResults)
        }
    });
});

app.get('/nullpackages', (req, res) => {
    const query3 = `SELECT p.* FROM packages p WHERE p.customer_id IS NULL`;
    db.query(query3, (err, packagesResults) => {
        if (err) {
            console.error("Error in third query:", err);
            return res.status(500).json({ error: "Failed to fetch data from third query" });
        } else {
            res.json(packagesResults)
        }
    });
});

app.get('/item', (req, res) => {
    const { id } = req.query;
    const query = "SELECT * FROM items WHERE tracking_number = ? AND item_status = 0;";
    db.query(query, [id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.json(results);
        }
    });
});

app.post('/additems', (req, res) => {
    const customer_id = req.body.customer_id;
    const tracking_number = req.body.tracking_number;
    const items = req.body.items;
    const query1 = "INSERT INTO `items` (`tracking_number`, `item_name`, `item_type`, `item_subtype`, `quantity`, `weight`, `packer_id`, `photo_url`) VALUES ?;";
    const values = items.map(item => [
        tracking_number,
        item.name,
        item.mainCategory,
        item.subCategory,
        item.quantity,
        item.weight,
        null,
        item.photo_url,
    ]);
    // Log the values array to inspect the final structure being passed to the query

    if ((values.length === 1) && ((values[0][1] === "") || (values[0][2] === ""))) {
        res.status(500).json({ error: "Failed to fetch data" });
    } else {
        db.query(query1, [values], (err, results) => {
            if (err) {
                console.error("Error fetching data:", err.message);
                res.status(500).json({ error: "Failed to fetch data" });
            } else {
                const query2 = `
                UPDATE customers 
                SET status = 'Warehouse' 
                WHERE status IS NULL AND customer_id =?;`;
                db.query(query2, [customer_id], (err, results) => {
                    if (err) {
                        console.error("Error updating customer status:", err.message);
                        res.status(500).json({ error: "Failed to update customer status" });
                    } else {
                        res.send("Values Added and Customer Status Updated");
                    }
                });
            }
        });
    }
});

app.post('/edititem', (req, res) => {
    const item_id = req.body.item_id;
    const item_name = req.body.item_name;
    const item_type = req.body.item_type;
    const item_subtype = req.body.item_subtype;
    const quantity = req.body.quantity;
    const weight = req.body.weight;
    const photo_url = req.body.photo_url;
    const query1 = "UPDATE `items` SET `item_name` = ?, `item_type` = ?, `item_subtype` = ?, `quantity` = ?, `weight` = ?, `photo_url` = ? WHERE `items`.`item_id` = ?;";
    db.query(query1, [item_name, item_type, item_subtype, quantity, weight, photo_url, item_id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.send("Values Edited");
        }
    });
});

app.post('/deleteitem', (req, res) => {
    const customer_id = req.body.customer_id;
    const item_id = req.body.item_id;
    const query1 = "DELETE FROM items WHERE `item_id` = ?;";
    db.query(query1, [item_id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        }
        // Query to check if all items with item_status = 0 for this customer
        const query2 = `
            SELECT COUNT(*) AS count 
            FROM items 
            WHERE tracking_number IN (
                SELECT tracking_number 
                FROM packages 
                WHERE customer_id = ?
            ) AND item_status = 0
        `;

        db.query(query2, [customer_id], (err, results) => {
            if (err) {
                console.error("Error checking item statuses:", err.message);
                return res.status(500).json({ error: "Failed to check item statuses" });
            }

            const count = results[0].count;

            if (count === 0) {
                // If all items have item_status = 0, update customer status to NULL
                const query4 = "UPDATE customers SET status = NULL WHERE status != 'Unpaid' AND customer_id = ?";

                db.query(query4, [customer_id], (err) => {
                    if (err) {
                        console.error("Error updating customer status:", err.message);
                        return res.status(500).json({ error: "Failed to update customer status" });
                    }

                    res.send("Item Deleted and Customer Status Updated to NULL");
                });
            } else {
                res.send("Item Deleted");
            }
        });
    });
});

app.post('/editwarehouse', (req, res) => {
    const id = req.body.customer_id;
    const warehouse = req.body.warehouse;
    const query = "UPDATE `customers` SET `warehouse` = ? WHERE `customers`.`customer_id` = ?;";
    db.query(query, [warehouse, id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.send("Values inserted");
        }
    });
});

app.post('/createcus', (req, res) => {
    const id = req.body.customer_id;
    const contact = req.body.contact;
    const type = req.body.type;
    const level = req.body.level;
    const note = req.body.note;
    const query = "INSERT INTO `customers` (`customer_id`, `contact`, `type`, `level`, `note`) VALUES (?, ?, ?, ?, ?);";
    db.query(query, [id, contact, type, level, note], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.send("Values inserted");
        }
    });
});

app.post('/editcus', (req, res) => {
    const old_id = req.body.old_id;
    const id = req.body.customer_id;
    const contact = req.body.contact;
    const type = req.body.type;
    const level = req.body.level;
    const note = req.body.note;
    const query3 = "UPDATE customers SET customer_id = ?, contact = ?, type = ?, level = ?, note = ? WHERE customer_id = ?;";
    db.query(query3, [id, contact, type, level, note, old_id], (err, results) => {
        if (err) {
            console.error("Error fetching data3:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.send("Values Edited");
        }
    });
});

app.post('/addaddr', (req, res) => {
    const customer_id = req.body.customer_id;
    const recipient_name = req.body.recipient_name;
    const phone = req.body.phone;
    const address = req.body.address;
    const city = req.body.city;
    const state = req.body.state;
    const country = req.body.country;
    const zipcode = req.body.zipcode;
    const email = req.body.email;
    const query1 = "INSERT INTO `addresses` (`customer_id`, `recipient_name`, `phone`, `address`, `city`, `state`, `country`, `zipcode`, `email`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);";
    db.query(query1, [customer_id, recipient_name, phone, address, city, state, country, zipcode, email], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.send("Values Edited");
        }
    });
});

app.post('/editaddr', (req, res) => {
    const address_id = req.body.address_id;
    const recipient_name = req.body.recipient_name;
    const phone = req.body.phone;
    const address = req.body.address;
    const city = req.body.city;
    const state = req.body.state;
    const country = req.body.country;
    const zipcode = req.body.zipcode;
    const query1 = "UPDATE `addresses` SET `recipient_name` = ?, `phone` = ?, `address` = ?, `city` = ?, `state` = ?, `country` = ?, `zipcode` = ? WHERE `address_id` = ?;";
    db.query(query1, [recipient_name, phone, address, city, state, country, zipcode, address_id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.send("Values Edited");
        }
    });
});

app.post('/deleteaddr', (req, res) => {
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

app.post('/addpackage', (req, res) => {
    const customer_id = req.body.customer_id;
    const processedcustomer_id = customer_id === 'MISSINGITEMS' ? null : customer_id
    const tracking_number = req.body.tracking_number;
    const photo_url = req.body.photo_url;
    const query1 = "INSERT INTO `packages` (`tracking_number`, `customer_id`, `photo_url`) VALUES (?, ?, ?);";
    db.query(query1, [tracking_number, processedcustomer_id, photo_url], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.send("Values Edited");
        }
    });
});

app.post('/editpackage', (req, res) => {
    const old_id = req.body.old_id;
    const customer_id = req.body.customer_id;
    const processedcustomer_id = customer_id === 'MISSINGITEMS' || customer_id === '' ? null : customer_id
    const tracking_number = req.body.tracking_number;
    const photo_url = req.body.photo_url;
    const query1 = "UPDATE `packages` SET `tracking_number` = ?, `customer_id` = ?, `photo_url` = ? WHERE `packages`.`tracking_number` = ?;";
    db.query(query1, [tracking_number, processedcustomer_id, photo_url, old_id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.send("Values Edited");
        }
    });
});

app.post('/deletepackage', (req, res) => {
    const customer_id = req.body.customer_id;
    const tracking = req.body.tracking;
    const query1 = "DELETE FROM items WHERE `tracking_number` = ? AND item_status = 0;";
    db.query(query1, [tracking], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        }
        const query2 = "DELETE FROM `packages` WHERE `packages`.`tracking_number` = ?;";
        db.query(query2, [tracking], (err, results) => {
            if (err) {
                res.send("Item Delete");
            }
            const query3 = `
                SELECT COUNT(*) AS count 
                FROM items 
                WHERE tracking_number IN (
                    SELECT tracking_number 
                    FROM packages 
                    WHERE customer_id = ?
                ) AND item_status = 0
            `;

            db.query(query3, [customer_id], (err, results) => {
                if (err) {
                    console.error("Error checking item statuses:", err.message);
                    return res.status(500).json({ error: "Failed to check item statuses" });
                }

                const count = results[0].count;

                if (count === 0) {
                    // If all items have item_status = 0, update customer status to NULL
                    const query4 = "UPDATE customers SET status = NULL WHERE customer_id = ? AND status != 'Unpaid'";

                    db.query(query4, [customer_id], (err) => {
                        if (err) {
                            console.error("Error updating customer status:", err.message);
                            return res.status(500).json({ error: "Failed to update customer status" });
                        }

                        res.send("Item Deleted and Customer Status Updated to NULL");
                    });
                } else {
                    res.send("Item Deleted");
                }
            });
        });
    });
});

// SubBox -------------------------------------------------------------------------------------------------------------------
app.get('/remainboxitem', (req, res) => {
    // ดึงค่า box_id จาก query parameter
    const { box_id } = req.query;
    // เปลี่ยนเงื่อนไขใน SQL ให้ตรงกับ box_id
    const query = "SELECT bi.*, bi.quantity - COALESCE(SUM(sbi.sub_quantity), 0) AS remaining_quantity, bi.weight * (bi.quantity - COALESCE(SUM(sbi.sub_quantity), 0)) / bi.quantity AS adjusted_weight FROM items bi LEFT JOIN subbox sb ON bi.box_id = sb.box_id LEFT JOIN subbox_item sbi ON sb.subbox_id = sbi.subbox_id AND bi.item_id = sbi.item_id WHERE bi.box_id = ? GROUP BY bi.item_id HAVING remaining_quantity != 0;";
    db.query(query, [box_id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.json(results);
        }
    });
});

app.get('/itemsubbox', (req, res) => {
    const { subbox_id } = req.query;
    const query = "SELECT *, i.weight * sbi.sub_quantity / i.quantity AS adjusted_weight FROM `subbox_item` sbi LEFT JOIN items i ON sbi.item_id = i.item_id WHERE `subbox_id` = ?;";
    db.query(query, [subbox_id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.json(results);
        }
    });
});

app.post('/edititemsubbox', (req, res) => {
    const subbox_id = req.body.subbox_id;
    const items = req.body.items;
    const query = "UPDATE `subbox_item` SET `sub_quantity` = ? WHERE `subbox_item`.`subbox_id` = ? AND `subbox_item`.`item_id` = ?;";
    const deleteQuery = "DELETE FROM `subbox_item` WHERE `subbox_item`.`subbox_id` = ? AND `subbox_item`.`item_id` = ?;";
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

app.get('/subboxinfo', (req, res) => {
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

app.post('/addsubbox', (req, res) => {
    const box_id = req.body.box_id;
    const weight = req.body.weight;
    const width = req.body.width;
    const b_long = req.body.b_long;
    const height = req.body.height;
    const img_url = req.body.img_url;
    const items = req.body.items;
    const query1 = "INSERT INTO `subbox` (`box_id`, `weight`, `width`, `b_long`, `height`, `img_url`) VALUES (?, ?, ?, ?, ?, ?);";
    db.query(query1, [box_id, weight, width, b_long, height, img_url], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            const subboxId = results.insertId;
            const values = items.map(item => [
                subboxId,
                item.item_id,
                item.selectedQuantity === 0 ? item.remaining_quantity : item.selectedQuantity,
            ]);
            if (values.length > 0) {
                const query2 = "INSERT INTO `subbox_item` (`subbox_id`, `item_id`, `sub_quantity`) VALUES ?;";
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
    });
});

app.post('/editsubbox', (req, res) => {
    const subbox_id = req.body.subbox_id;
    const weight = req.body.weight;
    const width = req.body.width;
    const b_long = req.body.b_long;
    const height = req.body.height;
    const img_url = req.body.img_url;
    const query1 = "UPDATE `subbox` SET `weight` = ?, `width` = ?, `b_long` = ?, `height` = ?, `img_url` = ? WHERE `subbox`.`subbox_id` = ?;";
    db.query(query1, [weight, width, b_long, height, img_url, subbox_id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.send("Values Edited");
        }
    });
});

app.post('/editsubbox_track', (req, res) => {
    const subbox_id = req.body.subbox_id;
    const subbox_tracking = req.body.subbox_tracking;
    const subbox_cost = req.body.subbox_cost;
    const query1 = "UPDATE `subbox` SET `subbox_tracking` = ?, `subbox_cost` = ? WHERE `subbox_id` = ?";
    const updates = subbox_id.map((id, index) => {
        console.log([subbox_tracking[index], subbox_cost[index], id.subbox_id])
        return new Promise((resolve, reject) => {
            db.query(query1, [subbox_tracking[index], subbox_cost[index], id.subbox_id], (err, results) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(results);
                }
            });
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

app.post('/deletesubbox', (req, res) => {
    const subbox_id = req.body.subbox_id;
    const queryDeleteSubboxItem = "DELETE FROM subbox_item WHERE `subbox_item`.`subbox_id` = ?;";
    const queryDeleteSubbox = "DELETE FROM subbox WHERE `subbox`.`subbox_id` = ?;";
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
            res.status(200).json({ success: true, message: "Subbox and associated items deleted successfully" });
        });
    });
});

app.post('/addsubboxitem', (req, res) => {
    const items = req.body.items;
    const subbox_id = req.body.subbox_id;
    const values = items.map(item => [
        subbox_id,
        item.item_id,
        item.quantity === 0 ? item.remaining_quantity : item.quantity,
    ]);
    const query2 = "INSERT INTO subbox_item (subbox_id, item_id, sub_quantity) VALUES ? ON DUPLICATE KEY UPDATE sub_quantity = sub_quantity + VALUES(sub_quantity);";
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
app.get('/box', (req, res) => {
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

app.post('/addbox', (req, res) => {
    // ดึงค่า box_id จาก query parameter
    const sender = req.body.submissionData.sender;
    const recipients = req.body.submissionData.recipients;
    const note = req.body.submissionData.note;
    const packages = req.body.submissionData.packages;
    // เปลี่ยนเงื่อนไขใน SQL ให้ตรงกับ box_id
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0'); // เดือนเริ่มจาก 0
    const day = String(now.getDate()).padStart(2, '0');
    const date = `${year}-${month}-${day}`;
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const time = `${hours}:${minutes}:${seconds}`;

    // สร้าง box_id
    const box_id = `${sender}_${date}T${time}`;
    const query = "INSERT INTO `box` (`box_id`, `customer_id`, `address_id`, `note`) VALUES (?, ?, ?, ?)";
    db.query(query, [box_id, sender, recipients, note], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            const boxId = box_id;
            const promises = [];
            packages.forEach((pkg) => {
                pkg.items.forEach((item) => {
                    const updateQuery = "UPDATE `items` SET `box_id` = ?, `item_status` = ? WHERE `item_id` = ?";
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

            const updateCustomerQuery = "UPDATE `customers` SET `packages` = `packages` + 1 WHERE `customer_id` = ?";
            const customerUpdatePromise = new Promise((resolve, reject) => {
                db.query(updateCustomerQuery, [sender], (err) => {
                    if (err) {
                        console.error("Error updating customer packages count:", err.message);
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

app.post('/deletebox', (req, res) => {
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
                                    res.status(500).json({ error: "Failed to delete box " + err });
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
                                    db.query(updateCustomerQuery, [customer_id, customer_id, customer_id], (err) => {
                                        if (err) {
                                            res.status(500).json({ error: "Failed to delete box2 " + err });
                                        } else {
                                            res.json({ message: "Box delete successfully", box_id });
                                        }
                                    });
                                }
                            });
                        }
                    });
                }
            });
        }
    });
});


app.get('/boxitem', (req, res) => {
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

app.get('/boxslip', (req, res) => {
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

app.get('/subbox', (req, res) => {
    // ดึงค่า box_id จาก query parameter
    const { box_id } = req.query;
    // เปลี่ยนเงื่อนไขใน SQL ให้ตรงกับ box_id
    // 1. ดึงข้อมูลจากตาราง subbox ที่มี box_id ตามที่กำหนด
    const querySubbox = "SELECT subbox.*, ROUND(GREATEST(subbox.weight, (subbox.width * subbox.b_long * subbox.height) / 5000), 2) AS volumetricWeight FROM subbox WHERE box_id = ?;";
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
        const subboxIds = subboxes.map(sub => sub.subbox_id);
        // เช่น [1, 2, 3, ...]

        // ใช้ IN(?) เพื่อดึงข้อมูล subbox_item ทั้งหมดที่ subbox_id อยู่ใน list
        const querySubboxItem = "SELECT *, i.weight * sbi.sub_quantity / i.quantity AS adjusted_weight FROM subbox_item sbi LEFT JOIN items AS i ON sbi.item_id = i.item_id WHERE subbox_id IN (?);";
        db.query(querySubboxItem, [subboxIds], (err, subboxItems) => {
            if (err) {
                console.error("Error fetching subbox_items:", err.message);
                return res.status(500).json({ error: "Failed to fetch subbox_items" });
            }

            // 3. รวมข้อมูล subbox กับ subbox_item ให้เป็นโครงสร้างซ้อนกัน
            // เช่น [{ subbox_id: 1, box_id: 10, ..., items: [ {...}, {...} ] }, ...]
            const subboxMap = {};
            // เตรียม map เพื่อเก็บ subbox แต่ละตัว โดย key คือ subbox_id

            subboxes.forEach(sb => {
                subboxMap[sb.subbox_id] = {
                    ...sb,
                    items: []  // เตรียม array ว่าง ๆ สำหรับ subbox_item
                };
            });

            subboxItems.forEach(item => {
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

app.get('/subbox_box', (req, res) => {
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

app.post('/createslip', (req, res) => {
    const slip = req.body.slip;
    const amount = req.body.amount;
    const details = req.body.details;
    const bid = req.body.BoxId;
    const query = "INSERT INTO `slip` (`box_id`, `slip_img`, `price`, `details`) VALUES (?, ?, ?, ?);";
    db.query(query, [bid, slip, amount, details], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.send("Values inserted");
        }
    });
});

app.post('/deleteslip', (req, res) => {
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
app.get('/box1', (req, res) => {
    const query = "SELECT * FROM box WHERE box_status = 'Ordered' ORDER BY `priority` ASC;;";
    db.query(query, (err, OrderedResults) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        }

        const query2 = "SELECT * FROM box WHERE box_status = 'Process' ORDER BY `priority` ASC;;";
        db.query(query2, (err, ProcessResults) => {
            if (err) {
                console.error("Error in second query:", err.message);
                return res.status(500).json({ error: "Failed to fetch data from second query" });
            }

            // Third Query
            const query3 = "SELECT * FROM box WHERE box_status = 'Packed' ORDER BY `priority` ASC;;";
            db.query(query3, (err, PackedResults) => {
                if (err) {
                    console.error("Error in third query:", err.message);
                    return res.status(500).json({ error: "Failed to fetch data from third query" });
                }
                res.json({
                    Ordered: OrderedResults,
                    Process: ProcessResults,
                    Packed: PackedResults
                });
            });
        });
    });
});

app.get('/box2', (req, res) => {
    const query = "SELECT * FROM box WHERE box_status = 'Paid' ORDER BY `priority` ASC;;";
    db.query(query, (err, PaidResults) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        }

        const query2 = "SELECT * FROM box WHERE box_status = 'Documented' ORDER BY `priority` ASC;;";
        db.query(query2, (err, DocumentedResults) => {
            if (err) {
                console.error("Error in second query:", err.message);
                return res.status(500).json({ error: "Failed to fetch data from second query" });
            }
            res.json({
                Paid: PaidResults,
                Documented: DocumentedResults,
            });
        });
    });
});

app.post('/editbox', (req, res) => {
    const box_id = req.body.box_id;
    const box_status = req.body.box_status
    if (req.body.bprice !== undefined) {
        const bprice = req.body.bprice;
        const customer_id = req.body.customer_id;
        const document = req.body.document
        const query1 = "UPDATE `box` SET `box_status` = ?, `bprice` = ?, `document` = ? WHERE `box_id` = ?;";
        db.query(query1, [box_status, bprice, document, box_id], (err, results) => {
            if (err) {
                console.error("Error fetching data:", err.message);
                res.status(500).json({ error: "Failed to fetch data" });
            }
            if (box_status === 'Packed') {
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
        const discount = req.body.discount
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
        const customer_id = req.body.customer_id
        const query1 = "UPDATE `box` SET `box_status` = ? WHERE `box_id` = ?;";
        db.query(query1, [box_status, box_id], (err, results) => {
            if (err) {
                console.error("Error fetching data:", err.message);
                res.status(500).json({ error: "Failed to fetch data" });
            } else {
                if (box_status === 'Paid') {
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
                } else {
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

app.post('/editpriority', (req, res) => {
    const box_id = req.body.box_id;
    const priority = req.body.priority
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

app.get('/appointment', (req, res) => {
    const query = "SELECT *, DATE_FORMAT(start_date, '%Y-%m-%d') AS formatted_start_date FROM appointment WHERE status = 'Pending'";
    db.query(query, (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.json(results);
        }
    });
});

app.post('/addappoint', (req, res) => {
    const title = req.body.title;
    const address_pickup = req.body.address_pickup;
    const phone_pickup = req.body.phone_pickup;
    const name_pickup = req.body.name_pickup;
    const position = req.body.position;
    const vehicle = req.body.vehicle;
    const note = req.body.note;
    const pickupdate = req.body.pickupdate;
    const pickupTime = req.body.pickupTime;
    const dateTime = new Date(`${pickupdate}T${pickupTime}:00.000Z`);
    const start_time = dateTime.toISOString().replace('T', ' ').replace('.000Z', '');
    dateTime.setMinutes(dateTime.getMinutes() + 30);
    const end_time = dateTime.toISOString().replace('T', ' ').replace('.000Z', '');
    const query1 = "INSERT INTO `appointment` (`title`, `start_date`, `end_data`, `note`, `customer_id`, `address_pickup`, `phone_pickup`, `name_pickup`, `position`, `vehicle`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);";
    db.query(query1, [title, start_time, end_time, note, title, address_pickup, phone_pickup, name_pickup, position, vehicle], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.send("Values Edited");
        }
    });
});

app.post('/editappoint', (req, res) => {
    const address_id = req.body.address_id;
    const address_pickup = req.body.address_pickup;
    const phone_pickup = req.body.phone_pickup;
    const name_pickup = req.body.name_pickup;
    const position = req.body.position;
    const vehicle = req.body.vehicle;
    const note = req.body.note;
    const query1 = "UPDATE `appointment` SET `note` = ?, `address_pickup` = ?, `phone_pickup` = ?, `name_pickup` = ?, `position` = ?, `vehicle` = ? WHERE `appointment`.`appoint_id` = ?;";
    db.query(query1, [note, address_pickup, phone_pickup, name_pickup, position, vehicle, address_id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.send("Values Edited");
        }
    });
});

// ThaiBox-------------------------------------------------------------------------------------------------------------------
app.get('/gentrack', (req, res) => {
    const { type } = req.query;
    const typelike = type + "%";
    const query = "SELECT tracking_number FROM `packages` WHERE `tracking_number` LIKE ? ORDER BY CAST(SUBSTRING(tracking_number, INSTR(tracking_number, '-') + 1) AS UNSIGNED) DESC LIMIT 1;";
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
app.post('/editsendaddr', (req, res) => {
    const customer_id = req.body.customer_id;
    const customer_name = req.body.customer_name;
    const address = req.body.address;
    const city = req.body.city;
    const state = req.body.state;
    const country = req.body.country;
    const zipcode = req.body.zipcode;
    const phone = req.body.phone;
    const doc_type = req.body.doc_type;
    const doc_url = req.body.doc_url;
    if (req.body.doc_url !== undefined) {
        const query1 = "UPDATE `customers` SET `customer_name` = ?, `address` = ?, `city` = ?, `state` = ?, `country` = ?, `zipcode` = ?, `phone` = ?, `doc_type` = ?, `doc_url` = ? WHERE `customers`.`customer_id` = ?;";
        db.query(query1, [customer_name, address, city, state, country, zipcode, phone, doc_type, doc_url, customer_id], (err, results) => {
            if (err) {
                console.error("Error fetching data:", err.message);
                res.status(500).json({ error: "Failed to fetch data" });
            } else {
                res.send("Values Edited");
            }
        });
    } else {
        const query1 = "UPDATE `customers` SET `customer_name` = ?, `address` = ?, `city` = ?, `state` = ?, `country` = ?, `zipcode` = ?, `phone` = ? WHERE `customers`.`customer_id` = ?;";
        db.query(query1, [customer_name, address, city, state, country, zipcode, phone, customer_id], (err, results) => {
            if (err) {
                console.error("Error fetching data:", err.message);
                res.status(500).json({ error: "Failed to fetch data" });
            } else {
                res.send("Values Edited");
            }
        });
    }

});

// Setting-------------------------------------------------------------------------------------------------------------------
app.get("/company_info", (req, res) => {
    const { emp_id } = req.query;
    const query = "SELECT * FROM `employee` WHERE `emp_id` = ?";
    companydb.query(query, [emp_id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            const filePath = `${results[0].company_name}/company_info.json`;
            fs.readFile(filePath, "utf-8", (err, data) => {
                if (err) {
                    console.error("Error reading JSON file:", err);
                    res.status(500).json({ error: "Failed to load company information" });
                } else {
                    res.json(JSON.parse(data));
                }
            });
        }
    });
});

app.get("/dropdown", (req, res) => {
    const { emp_id } = req.query;
    const query = "SELECT * FROM `employee` WHERE `emp_id` = ?";
    companydb.query(query, [emp_id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            const filePath = `${results[0].company_name}/dropdown.json`;
            fs.readFile(filePath, "utf-8", (err, data) => {
                if (err) {
                    console.error("Error reading JSON file:", err);
                    res.status(500).json({ error: "Failed to load company information" });
                } else {
                    res.json(JSON.parse(data));
                }
            });
        }
    });
});

app.post("/editdropdown", (req, res) => {
    const newData = req.body;
    const uniqueChannels = [...new Set(newData.channels.map(channel => channel.name))];
    const uniqueCategories = [...new Set(newData.categories.map(channel => channel.name))];
    const uniqueLevels = [...new Set(newData.levels.map(channel => channel.name))];
    const processedData = {
        channels: uniqueChannels,
        categories: uniqueCategories,
        levels: uniqueLevels
    };
    const emp_id = req.body.emp_id;
    const query = "SELECT * FROM `employee` WHERE `emp_id` = ?";
    companydb.query(query, [emp_id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            const filePath = `${results[0].company_name}/dropdown.json`;
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
    const query = "SELECT * FROM `employee` WHERE `emp_id` = ?";
    companydb.query(query, [emp_id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            const filePath = `${results[0].company_name}/price.json`;
            
            fs.readFile(filePath, "utf-8", (err, data) => {
                if (err) {
                    console.error("Error reading JSON file:", err);
                    res.status(500).json({ error: "Failed to load company information" });
                } else {
                    res.json(JSON.parse(data));
                }
            });
        }
    });
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
            const filePath = `${results[0].company_name}/price.json`;
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
    const query = "SELECT * FROM `employee` WHERE `emp_id` = ?";
    companydb.query(query, [emp_id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            const filePath = `${results[0].company_name}/promotion.json`;
            fs.readFile(filePath, "utf-8", (err, data) => {
                if (err) {
                    console.error("Error reading JSON file:", err);
                    res.status(500).json({ error: "Failed to load company information" });
                } else {
                    res.json(JSON.parse(data));
                }
            });
        }
    });
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
            const filePath = `${results[0].company_name}/promotion.json`;
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
    const query = "SELECT * FROM `employee` WHERE `emp_id` = ?";
    companydb.query(query, [emp_id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            const filePath = `${results[0].company_name}/warehouse.json`;
            fs.readFile(filePath, "utf-8", (err, data) => {
                if (err) {
                    console.error("Error reading JSON file:", err);
                    res.status(500).json({ error: "Failed to load company information" });
                } else {
                    res.json(JSON.parse(data));
                }
            });
        }
    });
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
            const filePath = `${results[0].company_name}/warehouse.json`;
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
    companydb.query(query, [id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.json(results);
        }
    });
});

app.post('/addemployee', (req, res) => {
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
            const query1 = "INSERT INTO `employee` (`username`, `emp_name`, `password`, `emp_database`, `emp_datapass`, `company_name`, `role`, `eimg`, `emp_date`) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?);";
            companydb.query(query1, [username, emp_name, password, results[0].emp_database, results[0].emp_datapass, results[0].company_name, role, emp_date], (err, results) => {
                if (err) {
                    console.error("Error fetching data:", err.message);
                    res.status(500).json({ error: "Failed to fetch data" });
                } else {
                    res.send("Values Edited");
                }
            });
        }
    });
});

app.post("/editemployee", (req, res) => {
    const emp_id = req.body.emp_id;
    const emp_name = req.body.emp_name;
    const password = req.body.password;
    const role = req.body.role;
    const username = req.body.username;
    const query = "UPDATE `employee` SET `username` = ?, `emp_name` = ?, `password` = ?, `role` = ? WHERE `employee`.`emp_id` = ?;";
    companydb.query(query, [username, emp_name, password, role, emp_id], (err, results) => {
        if (err) {
            console.error("Error fetching data:", err.message);
            res.status(500).json({ error: "Failed to fetch data" });
        } else {
            res.json(results);
        }
    });
});

app.post('/deleteemployee', (req, res) => {
    const emp_id = req.body.emp_id;
    const query1 = "DELETE FROM `employee` WHERE `employee`.`emp_id` = ? AND `employee`.`role` != 'owner'";
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
            const filePath = `${results[0].company_name}/company_info.json`;
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

const multer = require("multer");

//--------------------------------------------------- IMAGE UPLOAD ---------------------------------------------------

const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, "uploads", "img"); // Ensure the folder path for images
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
            return res.status(400).json({ success: false, message: "No file uploaded" });
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

app.post("/uploadPackageImage", uploadImage.single("packageImage"), (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({ success: false, message: "No file uploaded" });
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

app.post("/uploadItemImage", uploadImage.single("itemImage"), (req, res) => {
    try {
        const { fileName } = req.body; // Get the desired filename from the request body
        const file = req.file;

        if (!file) {
            return res.status(400).json({ success: false, message: "No file uploaded" });
        }

        const uploadDir = path.join(__dirname, "uploads", "img");
        const newFilePath = path.join(uploadDir, fileName);

        // Rename the file to the desired format
        fs.renameSync(file.path, newFilePath);

        res.status(200).json({
            success: true,
            message: "File uploaded successfully",
            filePath: fileName,
        });
    } catch (error) {
        console.error("Error handling file upload:", error.message);
        res.status(500).json({ success: false, message: "Internal server error" });
    }
});

app.post("/uploadSlip", uploadImage.single("slip"), (req, res) => {
    try {
        const { file } = req;
        if (!file) {
            return res.status(400).json({ success: false, message: "No file uploaded" });
        }

        // Log the file path and other metadata if needed
        res.status(200).json({ success: true, filePath: file.filename });
    } catch (error) {
        console.error("Error uploading slip:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
});

app.post("/uploadVerifyImg", uploadImage.single("verifyImg"), (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({ success: false, message: "No file uploaded" });
        }

        res.status(200).json({
            success: true,
            message: "File uploaded successfully",
            filePath: file.filename,
        });
    } catch (error) {
        console.error("Error uploading verify image:", error.message);
        res.status(500).json({ success: false, message: "Internal server error" });
    }
});

app.post("/deleteLogoImages", (req, res) => {
    try {
        // Define the directory where the images are stored
        const directoryPath = path.join(__dirname, "uploads", "img"); // Replace "uploads" with your directory

        // Read all files in the directory
        fs.readdir(directoryPath, (err, files) => {
            if (err) {
                console.error("Error reading directory:", err);
                return res.status(500).json({ success: false, message: "Error reading directory" });
            }

            // Filter files starting with "logo"
            const logoFiles = files.filter(file => file.startsWith("logo"));
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
    } catch (error) {
        console.error("Error handling delete request:", error.message);
        res.status(500).json({ success: false, message: "Internal server error" });
    }
});

app.post("/deletePackageImages", (req, res) => {
    try {
        // Define the directory where the images are stored
        const { photo_url } = req.body;
        const directoryPath = path.join(__dirname, "uploads", "img"); // Replace "uploads" with your directory
        // Read all files in the directory

        fs.readdir(directoryPath, (err, files) => {
            if (err) {
                console.error("Error reading directory:", err);
                return res.status(500).json({ success: false, message: "Error reading directory" });
            }

            // Filter files starting with "logo"
            const logoFiles = files.filter(file => file.startsWith(photo_url));
            // Delete each matching file
            logoFiles.forEach(file => {
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
        const directoryPath = path.join(__dirname, "uploads", "img"); // Replace with your directory
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

app.use("/uploads/img", express.static(path.join(__dirname, "uploads", "img")));

// Enhanced storage configuration
const documentStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, "uploads", "doc");
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
            return res.status(400).json({ success: false, message: "No file uploaded" });
        }

        // Failsafe: Check directory existence after upload
        const uploadDir = path.resolve(__dirname, "uploads", "doc");
        if (!fs.existsSync(uploadDir)) {
            console.error("Upload directory missing after upload:", uploadDir);
            throw new Error("Upload directory vanished unexpectedly.");
        }

        const savedPath = path.join("uploads", "doc", file.originalname);
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
        const result = await db.query(`
            SELECT customers.customer_id, customers.contact, customers.type, customers.level, customers.note
            FROM customers
            INNER JOIN packages ON customers.customer_id = packages.customer_id
            WHERE packages.tracking_number = ?
        `, [trackingNumber]);

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
