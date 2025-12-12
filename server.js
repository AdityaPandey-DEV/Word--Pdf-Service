const express = require('express');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const execAsync = promisify(exec);

// Request queue to prevent concurrent conversions
class ConversionQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  async enqueue(docxUrl, callback) {
    return new Promise((resolve, reject) => {
      this.queue.push({ docxUrl, callback, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    const request = this.queue.shift();
    
    try {
      const result = await request.callback();
      request.resolve(result);
    } catch (error) {
      request.reject(error);
    } finally {
      // Small delay between conversions to prevent resource conflicts
      await new Promise(resolve => setTimeout(resolve, 1000));
      this.processing = false;
      this.processQueue();
    }
  }
}

const conversionQueue = new ConversionQueue();

// Convert DOCX to PDF using LibreOffice with timeout and process monitoring
async function convertDocxToPdf(docxBuffer, outputDir, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const inputFile = path.join(os.tmpdir(), `input_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.docx`);
    
    // Write input file
    fs.writeFile(inputFile, docxBuffer)
      .then(() => {
        console.log(`📝 Input file written: ${inputFile} (${docxBuffer.length} bytes)`);
        
        // Spawn LibreOffice process
        const child = spawn('libreoffice', [
          '--headless',
          '--convert-to', 'pdf',
          '--outdir', outputDir,
          inputFile
        ], {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false
        });
        
        let stdout = '';
        let stderr = '';
        let timeoutId = null;
        let processKilled = false;
        
        // Capture stdout
        child.stdout.on('data', (data) => {
          stdout += data.toString();
          console.log(`📄 LibreOffice stdout: ${data.toString().trim()}`);
        });
        
        // Capture stderr
        child.stderr.on('data', (data) => {
          stderr += data.toString();
          console.log(`⚠️ LibreOffice stderr: ${data.toString().trim()}`);
        });
        
        // Set timeout to kill process
        timeoutId = setTimeout(() => {
          if (!child.killed && child.exitCode === null) {
            processKilled = true;
            console.error(`⏱️ Conversion timeout after ${timeoutMs}ms, killing process...`);
            child.kill('SIGTERM');
            
            // Force kill after 5 seconds if still running
            setTimeout(() => {
              if (child.exitCode === null) {
                console.error('💀 Force killing LibreOffice process...');
                child.kill('SIGKILL');
              }
            }, 5000);
          }
        }, timeoutMs);
        
        // Handle process completion
        child.on('close', (code, signal) => {
          const duration = Date.now() - startTime;
          clearTimeout(timeoutId);
          
          // Cleanup input file
          fs.unlink(inputFile).catch(() => {
            console.warn('⚠️ Failed to cleanup input file');
          });
          
          console.log(`⏱️ Conversion completed in ${duration}ms (code: ${code}, signal: ${signal})`);
          
          if (processKilled) {
            reject(new Error(`LibreOffice conversion timeout after ${timeoutMs}ms. Duration: ${duration}ms. Stdout: ${stdout || 'none'}. Stderr: ${stderr || 'none'}`));
            return;
          }
          
          if (code !== 0) {
            console.error(`❌ LibreOffice failed with code ${code}`);
            console.error(`📄 Stdout: ${stdout || '(empty)'}`);
            console.error(`⚠️ Stderr: ${stderr || '(empty)'}`);
            reject(new Error(`LibreOffice conversion failed: code ${code}, duration: ${duration}ms, stderr: ${stderr || 'none'}, stdout: ${stdout || 'none'}`));
            return;
          }
          
          // Find generated PDF
          fs.readdir(outputDir)
            .then(files => {
              const pdfFiles = files.filter(f => f.endsWith('.pdf'));
              if (pdfFiles.length === 0) {
                reject(new Error(`PDF file not generated. Output directory: ${outputDir}, files: ${files.join(', ')}`));
                return;
              }
              
              const pdfFile = path.join(outputDir, pdfFiles[0]);
              fs.stat(pdfFile)
                .then(stat => {
                  console.log(`✅ PDF generated: ${pdfFile} (${stat.size} bytes)`);
                  resolve(pdfFile);
                })
                .catch(reject);
            })
            .catch(reject);
        });
        
        // Handle spawn errors
        child.on('error', (error) => {
          clearTimeout(timeoutId);
          console.error('❌ LibreOffice spawn error:', error);
          
          // Cleanup input file
          fs.unlink(inputFile).catch(() => {
            console.warn('⚠️ Failed to cleanup input file');
          });
          
          reject(error);
        });
      })
      .catch(reject);
  });
}

// Wrapper function for backward compatibility (downloads DOCX and converts)
async function convertDocxToPdfFromUrl(docxUrl, orderId) {
  // Check if this is a test/health-check URL
  if (docxUrl === 'test' || docxUrl === 'health-check' || !docxUrl.startsWith('http')) {
    throw new Error('Invalid DOCX URL: Only absolute URLs are supported');
  }
  
  const tempDir = os.tmpdir();
  const timestamp = Date.now();
  const outputDir = path.join(tempDir, `output_${orderId}_${timestamp}`);
  
  try {
    // Download DOCX file
    console.log(`📥 Downloading DOCX from: ${docxUrl}`);
    const response = await fetch(docxUrl);
    if (!response.ok) {
      throw new Error(`Failed to download DOCX: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.buffer();
    console.log(`✅ DOCX downloaded: ${buffer.length} bytes`);
    
    // Create output directory
    await fs.mkdir(outputDir, { recursive: true });
    
    // Convert using LibreOffice with timeout
    console.log(`🔄 Running LibreOffice conversion...`);
    const pdfPath = await convertDocxToPdf(buffer, outputDir, 60000);
    
    // Read PDF
    const pdfBuffer = await fs.readFile(pdfPath);
    console.log(`✅ PDF generated: ${pdfBuffer.length} bytes`);
    
    // Cleanup
    try {
      await fs.unlink(pdfPath);
      await fs.rm(outputDir, { recursive: true, force: true });
      console.log(`🧹 Cleaned up temporary files`);
    } catch (cleanupError) {
      console.warn(`⚠️ Cleanup warning: ${cleanupError.message}`);
    }
    
    return pdfBuffer;
  } catch (error) {
    // Cleanup on error
    try {
      await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    } catch (cleanupError) {
      console.warn(`⚠️ Cleanup error: ${cleanupError.message}`);
    }
    throw error;
  }
}

// Keep-alive endpoint to prevent auto-stop
app.get('/keepalive', (req, res) => {
  res.json({
    status: 'ok',
    service: 'word-pdf-service',
    timestamp: new Date().toISOString()
  });
});

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
    convertDocxToPdfFromUrl(docxUrl, orderId)
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
    
    // Queue the conversion
    const result = await new Promise((resolve, reject) => {
      conversionQueue.enqueue(docxUrl, async () => {
        try {
          // Download DOCX
          console.log(`📥 Downloading DOCX from: ${docxUrl}`);
          const docxResponse = await fetch(docxUrl);
          if (!docxResponse.ok) {
            throw new Error(`Failed to download DOCX: ${docxResponse.status}`);
          }
          const docxBuffer = await docxResponse.buffer();
          console.log(`✅ DOCX downloaded: ${docxBuffer.length} bytes`);
          
          // Create unique output directory
          const outputDir = path.join(os.tmpdir(), `output_sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);
          await fs.mkdir(outputDir, { recursive: true });
          
          // Convert to PDF with timeout
          console.log(`🔄 Running LibreOffice conversion...`);
          const pdfPath = await convertDocxToPdf(docxBuffer, outputDir, 60000); // 60 second timeout
          
          // Read PDF
          const pdfBuffer = await fs.readFile(pdfPath);
          console.log(`✅ PDF generated: ${pdfBuffer.length} bytes`);
          
          // Cleanup
          try {
            await fs.unlink(pdfPath);
            await fs.rm(outputDir, { recursive: true, force: true });
            console.log(`🧹 Cleaned up temporary files`);
          } catch (e) {
            console.warn('⚠️ Failed to cleanup:', e);
          }
          
          return {
            success: true,
            pdfBuffer: pdfBuffer.toString('base64'),
            size: pdfBuffer.length
          };
        } catch (error) {
          console.error(`❌ Error in synchronous conversion:`, error);
          throw error;
        }
      }).then(resolve).catch(reject);
    });
    
    res.json(result);
  } catch (error) {
    console.error(`❌ Conversion endpoint error:`, error);
    res.status(500).json({
      success: false,
      error: error.message || 'Conversion failed'
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
  
  // Pre-warm LibreOffice to avoid first-request delay
  exec('libreoffice --version', (error, stdout, stderr) => {
    if (error) {
      console.error(`   ⚠️ LibreOffice not found: ${error.message}`);
    } else {
      console.log(`   ✅ LibreOffice: ${stdout.trim()}`);
      
      // Run a lightweight command to fully initialize LibreOffice
      console.log(`   🔥 Pre-warming LibreOffice...`);
      exec('libreoffice --headless --version', (warmError, warmStdout, warmStderr) => {
        if (warmError) {
          console.warn(`   ⚠️ LibreOffice pre-warm warning: ${warmError.message}`);
        } else {
          console.log(`   ✅ LibreOffice pre-warmed and ready`);
        }
      });
    }
  });
});

