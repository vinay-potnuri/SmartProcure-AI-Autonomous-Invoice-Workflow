
import { createRequire } from "module";
const require = createRequire(import.meta.url);

async function test() {
  try {
    const pdf = require("pdf-parse");
    console.log("Type of pdf:", typeof pdf);
    
    // Create a minimal PDF buffer (header only) to see if it starts parsing
    const fakeBuffer = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF");
    
    console.log("Calling pdf(fakeBuffer)...");
    try {
      const data = await pdf(fakeBuffer);
      console.log("Success (unexpectedly for fake buffer):", data);
    } catch (err) {
      console.log("Caught expected error or actual bug:", err.message);
      if (err.stack) console.log(err.stack);
    }
  } catch (e) {
    console.log("Import error:", e.message);
  }
}

test();
