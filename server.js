const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 8080; // Cloud Run uses port 8080 by default

// Dedicated folder for files
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer storage: keep files safely on disk
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}-${safeName}`);
    }
});
const upload = multer({ storage: storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(uploadDir));

// SQLite DB
const db = new sqlite3.Database('./database.sqlite');
db.run(`CREATE TABLE IF NOT EXISTS shares (
    share_id TEXT PRIMARY KEY,
    content TEXT,
    original_name TEXT,
    stored_name TEXT,
    created_at INTEGER
)`);

function generateId() {
    return Math.random().toString(36).substring(2, 6);
}

// 1. UPLOAD (Text or Any File Format)
app.post('/api/share', upload.single('file'), (req, res) => {
    const content = req.body.content || null;
    const file = req.file || null;

    if (!content && !file) return res.status(400).json({ error: "Nothing to share!" });

    const shareId = generateId();
    const now = Date.now();
    const query = `INSERT INTO shares (share_id, content, original_name, stored_name, created_at) VALUES (?, ?, ?, ?, ?)`;

    db.run(query, [shareId, content, file ? file.originalname : null, file ? file.filename : null, now], (err) => {
        if (err) return res.status(500).json({ error: err.message });

        // Build live URL dynamically
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        const shareUrl = `${protocol}://${host}/?id=${shareId}`;

        res.json({ shareId, shareUrl });
    });
});

// 2. RETRIEVE (Check if < 24 Hours)
aapp.get('/download/:id', (req, res) => {
  const { id } = req.params;

  db.get('SELECT * FROM shares WHERE id = ?', [id], (err, item) => {
    if (err || !item) {
      return res.status(404).send('<h2>File or content not found or expired.</h2>');
    }

    // 1. If it is stored text / content
    if (item.content || item.text) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Quick-Share Note</title>
          <link rel="stylesheet" href="/style.css" />
        </head>
        <body style="display:flex; justify-content:center; align-items:center; min-height:100vh; background:#0d1117; color:#c9d1d9; font-family:sans-serif; margin:0; padding:1rem;">
          <div style="background:#161b22; border:1px solid #30363d; border-radius:12px; padding:2rem; max-width:500px; width:100%; word-break:break-word;">
            <h2 style="color:#f0f6fc; margin-top:0;">Shared Content</h2>
            <pre style="white-space:pre-wrap; background:#0d1117; padding:1rem; border-radius:6px; border:1px solid #30363d; color:#c9d1d9;">${item.content || item.text}</pre>
            <a href="/" style="display:inline-block; margin-top:1rem; color:#58a6ff; text-decoration:none;">← Upload another file or text</a>
          </div>
        </body>
        </html>
      `);
    }

    // 2. If it is an uploaded file
    if (item.stored_name) {
      const filePath = path.join(uploadDir, item.stored_name);
      return res.download(filePath, item.original_name || 'download');
    }

    res.status(404).send('<h2>Invalid file record.</h2>');
  });
});

// 3. BACKGROUND CLEANUP: Delete expired files every hour
setInterval(() => {
    const expiryCutoff = Date.now() - 86400000;
    db.all(`SELECT stored_name FROM shares WHERE created_at < ? AND stored_name IS NOT NULL`, [expiryCutoff], (err, rows) => {
        if (!err && rows) {
            rows.forEach(r => {
                const filePath = path.join(uploadDir, r.stored_name);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            });
            db.run(`DELETE FROM shares WHERE created_at < ?`, [expiryCutoff]);
        }
    });
}, 3600000); // Check every 60 minutes

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Quick-Share running on port ${PORT}`);
});