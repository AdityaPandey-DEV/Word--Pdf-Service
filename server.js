const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const execAsync = promisify(exec);

// Convert DOCX to PDF using LibreOffice
async function convertDocxToPdf(docxUrl, orderId) {
  // Check if this is a test/health-check URL
  if (docxUrl === 'test' || docxUrl === 'health-check' || !docxUrl.startsWith('http')) {
    throw new Error('Invalid DOCX URL: Only absolute URLs are supported');
  }
  
  const tempDir = os.tmpdir();
  const timestamp = Date.now();
  const inputFile = path.join(tempDir, `input_${orderId}_${timestamp}.docx`);
  const outputDir = path.join(tempDir, `output_${orderId}_${timestamp}`);
  
  try {
    // Download DOCX file
    console.log(`📥 Downloading DOCX from: ${docxUrl}`);
    const response = await fetch(docxUrl);
    if (!response.ok) {
      throw new Error(`Failed to download DOCX: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.buffer();
    await fs.writeFile(inputFile, buffer);
    console.log(`✅ DOCX downloaded: ${buffer.length} bytes`);
    
    // Create output directory
    await fs.mkdir(outputDir, { recursive: true });
    
    // Convert using LibreOffice headless
    const command = `libreoffice --headless --convert-to pdf --outdir "${outputDir}" "${inputFile}"`;
    console.log(`🔄 Running LibreOffice conversion...`);
    console.log(`   Command: ${command}`);
    
    const { stdout, stderr } = await execAsync(command);
    if (stderr && !stderr.includes('INFO')) {
      console.warn(`⚠️ LibreOffice stderr: ${stderr}`);
    }
    if (stdout) {
      console.log(`📄 LibreOffice output: ${stdout}`);
    }
    
    // Find generated PDF
    const files = await fs.readdir(outputDir);
    const pdfFile = files.find(f => f.endsWith('.pdf'));
    
    if (!pdfFile) {
      throw new Error(`PDF file not generated. Files in output dir: ${files.join(', ')}`);
    }
    
    const pdfPath = path.join(outputDir, pdfFile);
    const pdfBuffer = await fs.readFile(pdfPath);
    console.log(`✅ PDF generated: ${pdfBuffer.length} bytes`);
    
    // Cleanup
    try {
      await fs.unlink(inputFile);
      await fs.rm(outputDir, { recursive: true, force: true });
      console.log(`🧹 Cleaned up temporary files`);
    } catch (cleanupError) {
      console.warn(`⚠️ Cleanup warning: ${cleanupError.message}`);
    }
    
    return pdfBuffer;
  } catch (error) {
    // Cleanup on error
    try {
      await fs.unlink(inputFile).catch(() => {});
      await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    } catch (cleanupError) {
      console.warn(`⚠️ Cleanup error: ${cleanupError.message}`);
    }
    throw error;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'word-pdf-service',
    timestamp: new Date().toISOString()
  });
});

// POST /api/convert - Receive conversion request
app.post('/api/convert', async (req, res) => {
  try {
    const { docxUrl, orderId, callbackUrl } = req.body;
    
    if (!docxUrl || !orderId || !callbackUrl) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: docxUrl, orderId, callbackUrl'
      });
    }
    
    console.log(`\n🔄 New conversion request received:`);
    console.log(`   Order ID: ${orderId}`);
    console.log(`   DOCX URL: ${docxUrl}`);
    console.log(`   Callback URL: ${callbackUrl}`);
    
    // Generate job ID
    const jobId = `job_${orderId}_${Date.now()}`;
    
    // Start conversion asynchronously (don't wait)
    convertDocxToPdf(docxUrl, orderId)
      .then(async (pdfBuffer) => {
        // Send PDF to webhook
        const base64Pdf = pdfBuffer.toString('base64');
        
        console.log(`\n✅ Conversion completed for order ${orderId}`);
        console.log(`   PDF size: ${pdfBuffer.length} bytes`);
        console.log(`   Sending to webhook: ${callbackUrl}`);
        
        try {
          const webhookResponse = await fetch(callbackUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-render-webhook-secret': process.env.RENDER_WEBHOOK_SECRET || ''
            },
            body: JSON.stringify({
              orderId,
              jobId,
              pdfBuffer: base64Pdf,
              status: 'completed'
            })
          });
          
          if (webhookResponse.ok) {
            console.log(`✅ Webhook sent successfully for order: ${orderId}`);
          } else {
            const errorText = await webhookResponse.text();
            console.error(`❌ Webhook failed: ${webhookResponse.status} ${errorText}`);
          }
        } catch (webhookError) {
          console.error(`❌ Error sending webhook:`, webhookError);
        }
      })
      .catch(async (error) => {
        console.error(`\n❌ Conversion failed for order ${orderId}:`);
        console.error(`   Error: ${error.message}`);
        console.error(`   Stack: ${error.stack}`);
        
        // Send failure notification
        try {
          await fetch(callbackUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-render-webhook-secret': process.env.RENDER_WEBHOOK_SECRET || ''
            },
            body: JSON.stringify({
              orderId,
              jobId,
              status: 'failed',
              error: error.message
            })
          });
          console.log(`✅ Failure webhook sent for order: ${orderId}`);
        } catch (webhookError) {
          console.error(`❌ Failed to send failure webhook:`, webhookError);
        }
      });
    
    // Return immediately with job ID
    res.json({
      success: true,
      jobId,
      message: 'Conversion job started'
    });
    
  } catch (error) {
    console.error('❌ Error starting conversion:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/convert-sync - Synchronous conversion (for real-time downloads)
app.post('/api/convert-sync', async (req, res) => {
  try {
    const { docxUrl } = req.body;
    
    if (!docxUrl) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: docxUrl'
      });
    }
    
    console.log(`\n🔄 Synchronous conversion request received:`);
    console.log(`   DOCX URL: ${docxUrl}`);
    
    // Convert synchronously (wait for completion)
    const pdfBuffer = await convertDocxToPdf(docxUrl, `sync_${Date.now()}`);
    
    // Return PDF as base64
    const base64Pdf = pdfBuffer.toString('base64');
    
    console.log(`✅ Synchronous conversion completed`);
    console.log(`   PDF size: ${pdfBuffer.length} bytes`);
    
    res.json({
      success: true,
      pdfBuffer: base64Pdf,
      size: pdfBuffer.length
    });
    
  } catch (error) {
    console.error('❌ Error in synchronous conversion:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/status/:jobId - Check conversion status (optional)
app.get('/api/status/:jobId', (req, res) => {
  // This is a placeholder - implement job tracking if needed
  res.json({
    success: true,
    status: 'processing',
    message: 'Status checking not implemented. Use webhook for completion notification.'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`\n🚀 Word PDF Service started`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   LibreOffice: Checking...`);
  
  // Verify LibreOffice is installed
  exec('libreoffice --version', (error, stdout, stderr) => {
    if (error) {
      console.error(`   ⚠️ LibreOffice not found: ${error.message}`);
    } else {
      console.log(`   ✅ LibreOffice: ${stdout.trim()}`);
    }
  });
});

