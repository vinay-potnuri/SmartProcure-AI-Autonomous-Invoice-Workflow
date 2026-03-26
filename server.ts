import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import cors from "cors";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const Tesseract = require("tesseract.js");
const Database = require("better-sqlite3");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Initialize PDF parser
  let pdfParser: any;
  
  // Direct PDF.js extraction function
  const extractTextWithPdfJs = async (dataBuffer: Buffer | Uint8Array) => {
    const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
    
    // Some versions of pdfjs-dist require setting the workerSrc
    // But for simple text extraction in Node, we can often skip it or use the fake worker
    
    const loadingTask = pdfjs.getDocument({
      data: dataBuffer,
      disableWorker: true,
      verbosity: 0
    });
    
    const pdf = await loadingTask.promise;
    let fullText = "";
    
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(" ");
      fullText += pageText + "\n\n";
    }
    
    return { text: fullText, numpages: pdf.numPages };
  };

  const loadPdfParse = async () => {
    try {
      console.log("Attempting to load pdf-parse...");
      
      // Try standard require
      let mod: any;
      try {
        mod = require("pdf-parse");
      } catch (e) {
        try {
          // Alternative require path that sometimes works better in Node
          mod = require("pdf-parse/lib/pdf-parse.js");
        } catch (e2) {
          console.warn("require('pdf-parse') and alternative path failed, trying dynamic import...");
        }
      }

      if (mod) {
        console.log("pdf-parse (require) loaded. Type:", typeof mod);
        if (typeof mod === 'function') {
          console.log("pdf-parse is a function. String:", mod.toString().substring(0, 100));
          return mod;
        }
        if (mod.default && typeof mod.default === 'function') return mod.default;
        // Only use .pdf if it's a function and mod itself is not a function
        if (mod.pdf && typeof mod.pdf === 'function') return mod.pdf;
      }
      
      // Try dynamic import
      let impMod: any;
      try {
        impMod = await import("pdf-parse");
      } catch (e) {
        console.warn("import('pdf-parse') failed.");
      }

      if (impMod) {
        console.log("pdf-parse (import) loaded. Type:", typeof impMod);
        if (typeof impMod === 'function') return impMod;
        if (impMod.default && typeof impMod.default === 'function') return impMod.default;
        if (impMod.pdf && typeof impMod.pdf === 'function') return impMod.pdf;
      }

      // Search for any function in the objects as a last resort
      const findFunc = (obj: any) => {
        if (!obj || typeof obj !== 'object') return null;
        // Avoid common non-parser functions
        const skip = ['toString', 'valueOf', 'toLocaleString', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable'];
        for (const key in obj) {
          if (typeof obj[key] === 'function' && !skip.includes(key)) return obj[key];
        }
        return null;
      };

      const func = findFunc(mod) || findFunc(impMod);
      if (func) {
        console.log("Found a function in pdf-parse module exports.");
        return func;
      }

      console.error("Could not find a valid function in pdf-parse module.");
      return mod || impMod;
    } catch (e) {
      console.error("Error loading pdf-parse:", e);
      return null;
    }
  };
  pdfParser = await loadPdfParse();
  console.log("PDF Parser initialization complete. Type:", typeof pdfParser);
  if (pdfParser && typeof pdfParser === 'object') {
    console.log("PDF Parser keys:", Object.keys(pdfParser));
  }

  try {
    const db = new Database("procurement.db");
    console.log("Database initialized successfully.");

    // Initialize database
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_trail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vendor TEXT,
        amount REAL,
        status TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        details TEXT
      )
    `);

    app.use(cors());
    app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
      next();
    });
    app.use(express.json());

    const upload = multer({ storage: multer.memoryStorage() });

    // API Routes
    app.post("/api/extract-invoice", upload.single("invoice"), async (req, res) => {
      console.log("POST /api/extract-invoice received");
      try {
        if (!req.file) {
          return res.status(400).json({ error: "No file uploaded" });
        }

        const mimetype = req.file.mimetype;
        let extractedText = "";

        if (mimetype === "application/pdf") {
          // PDF Extraction
          if (!req.file.buffer || req.file.buffer.length === 0) {
            throw new Error("Uploaded PDF file is empty.");
          }
          if (!pdfParser) {
            throw new Error("PDF parser initialization failed. Module not found.");
          }

          let pdfData;
          try {
            const options = { 
              disableWorker: true,
              nativeImage: false,
              verbosity: -1
            };
            
            // Try with original Buffer first, as some pdf-parse versions prefer it
            const dataBuffer = req.file.buffer;
            
            if (typeof pdfParser === 'function') {
              pdfData = await pdfParser(dataBuffer, options);
            } else if (pdfParser && typeof pdfParser.pdf === 'function') {
              pdfData = await pdfParser.pdf(dataBuffer, options);
            } else if (pdfParser && typeof pdfParser.default === 'function') {
              pdfData = await pdfParser.default(dataBuffer, options);
            } else {
              // Last ditch effort: try to call it anyway if it's truthy
              try {
                pdfData = await pdfParser(dataBuffer, options);
              } catch (e) {
                throw new Error(`pdfParser is not a valid function (type: ${typeof pdfParser})`);
              }
            }
          } catch (err: any) {
            console.error("Primary PDF extraction (pdf-parse) failed:", err.message);
            console.log("Attempting direct PDF.js extraction...");
            try {
              pdfData = await extractTextWithPdfJs(req.file.buffer);
              console.log("Direct PDF.js extraction successful.");
            } catch (secondErr: any) {
              console.error("Direct PDF.js extraction also failed:", secondErr.message);
              throw err; // Throw original error if both fail
            }
          }
          
          if (!pdfData) {
            throw new Error("PDF extraction returned no data.");
          }

          // Check for AbortException which is sometimes returned as an object
          if (pdfData.name === 'AbortException') {
            console.error("PDF extraction aborted:", pdfData);
            throw new Error("AbortException: PDF extraction was aborted by the library. This often happens with password-protected or highly complex PDFs.");
          }

          // Flexible text extraction
          if (typeof pdfData === 'string') {
            extractedText = pdfData;
          } else if (typeof pdfData.text === 'string') {
            extractedText = pdfData.text;
          } else if (pdfData.data && typeof pdfData.data.text === 'string') {
            extractedText = pdfData.data.text;
          } else if (pdfData.content && typeof pdfData.content === 'string') {
            extractedText = pdfData.content;
          } else {
            console.error("Unexpected PDF extraction result structure:", JSON.stringify(pdfData).substring(0, 500));
            throw new Error("PDF extraction failed to return text in a recognized format.");
          }
        } else if (mimetype.startsWith("image/")) {
          // Image OCR
          const { data: { text } } = await Tesseract.recognize(
            req.file.buffer,
            'eng',
            { logger: (m: any) => console.log(m) }
          );
          extractedText = text;
        } else {
          return res.status(400).json({ error: "Unsupported file type. Please upload a PDF or an image." });
        }

        res.json({ text: extractedText });
      } catch (error: any) {
        console.error("Extraction Error:", error);
        const errorMessage = error?.message || String(error);
        const errorName = error?.name || error?.constructor?.name || "";
        
        if (errorMessage.includes("InvalidPDFException") || errorName === "InvalidPDFException" || 
            errorMessage.includes("FormatError") || errorName === "FormatError") {
          return res.status(400).json({ error: "The PDF file is malformed or corrupted." });
        }
        if (errorMessage.includes("PasswordException") || errorName === "PasswordException") {
          return res.status(400).json({ error: "The PDF file is password protected." });
        }
        if (errorMessage.includes("AbortException") || errorName === "AbortException" || 
            errorMessage.includes("recognized format") || errorMessage.toLowerCase().includes("pdf")) {
          const cleanError = `AbortException: ${errorMessage}`;
          return res.status(400).json({ error: cleanError });
        }
        
        const finalError = errorMessage.includes("initialization failed") 
          ? "PDF parser initialization failed. Please contact support."
          : "Failed to extract text: " + (errorMessage || errorName);

        res.status(500).json({ error: finalError });
      }
    });

    app.get("/api/audit-trail", (req, res) => {
      console.log("GET /api/audit-trail received");
      try {
        const rows = db.prepare("SELECT * FROM audit_trail ORDER BY timestamp DESC").all();
        res.json(rows);
      } catch (error) {
        console.error("Database Error:", error);
        res.status(500).json({ error: "Failed to fetch audit trail" });
      }
    });

    app.post("/api/log-decision", (req, res) => {
      console.log("POST /api/log-decision received");
      try {
        const { vendor, amount, status, details } = req.body;
        const stmt = db.prepare(
          "INSERT INTO audit_trail (vendor, amount, status, details) VALUES (?, ?, ?, ?)"
        );
        stmt.run(vendor, amount, status, details);
        res.json({ success: true });
      } catch (error) {
        console.error("Database Error:", error);
        res.status(500).json({ error: "Failed to log decision" });
      }
    });

    // Global error handler for API routes
    app.use("/api/*", (err: any, req: any, res: any, next: any) => {
      console.error("Global API Error:", err);
      res.status(err.status || 500).json({ 
        error: err.message || "Internal Server Error",
        details: process.env.NODE_ENV === "development" ? err.stack : undefined
      });
    });

    // Catch-all for API routes to prevent HTML responses
    app.all("/api/*", (req, res) => {
      console.warn(`404 API Route Not Found: ${req.method} ${req.url}`);
      res.status(404).json({ error: `API route not found: ${req.method} ${req.url}` });
    });

    // Vite middleware for development
    if (process.env.NODE_ENV !== "production") {
      console.log("Starting server in DEVELOPMENT mode with Vite middleware.");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } else {
      console.log("Starting server in PRODUCTION mode.");
      const distPath = path.join(process.cwd(), "dist");
      app.use(express.static(distPath));
      app.get("*", (req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
      });
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    // Handle API errors in the error state
    app.all("/api/*", (req, res) => {
      res.status(503).json({ 
        error: "Server Initialization Failed", 
        details: String(err) 
      });
    });
    // Even if DB or routes fail, we should try to start listening to provide error feedback
    app.get("*", (req, res) => {
      res.status(500).send(`<h1>Server Initialization Failed</h1><pre>${err}</pre>`);
    });
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running in ERROR state on http://localhost:${PORT}`);
    });
  }
}

startServer();
