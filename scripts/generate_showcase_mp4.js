/**
 * generate_showcase_mp4.js — Genera MP4 de los 25 HTMLs animados de MIIA
 *
 * Usa Puppeteer para capturar frames + ffmpeg para encodear MP4.
 * Output: miia-backend/media/showcase/*.mp4
 *
 * Uso: node scripts/generate_showcase_mp4.js [--only 01_ventas,03_deportes]
 */

const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegPath);

// ── Config ──────────────────────────────────────────────────────────────
const HTML_DIR = path.resolve(__dirname, '../../BRAND MIIA/MKT MIIA/miia_individuales');
const OUTPUT_DIR = path.resolve(__dirname, '../media/showcase');
const TEMP_DIR = path.resolve(__dirname, '../media/showcase/.tmp_frames');
const FPS = 15;
const DURATION_SEC = 9;
const TOTAL_FRAMES = FPS * DURATION_SEC; // 135
const VIEWPORT = { width: 540, height: 720, deviceScaleFactor: 2 };
const PWA_VIEWPORT = { width: 540, height: 900, deviceScaleFactor: 2 };

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  // Parse --only flag
  const onlyArg = process.argv.find(a => a.startsWith('--only'));
  let onlyFilter = null;
  if (onlyArg) {
    const idx = process.argv.indexOf(onlyArg);
    const val = onlyArg.includes('=') ? onlyArg.split('=')[1] : process.argv[idx + 1];
    if (val) onlyFilter = val.split(',').map(s => s.trim());
  }

  // Get HTML files
  let htmlFiles = fs.readdirSync(HTML_DIR)
    .filter(f => f.endsWith('.html'))
    .sort();

  if (onlyFilter) {
    htmlFiles = htmlFiles.filter(f => {
      const name = f.replace('.html', '');
      return onlyFilter.some(o => name.includes(o));
    });
  }

  console.log(`\n📽️  MIIA Showcase MP4 Generator`);
  console.log(`   ${htmlFiles.length} HTMLs → MP4 (${FPS}fps, ${DURATION_SEC}s, ${VIEWPORT.width}x${VIEWPORT.height})`);
  console.log(`   Output: ${OUTPUT_DIR}\n`);

  // Ensure dirs
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  // Launch browser
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none'
    ]
  });

  let success = 0;
  let failed = 0;

  for (const file of htmlFiles) {
    const name = file.replace('.html', '');
    const outputMp4 = path.join(OUTPUT_DIR, `${name}.mp4`);

    // Skip if already generated (use --force to regenerate)
    if (fs.existsSync(outputMp4) && !process.argv.includes('--force')) {
      console.log(`   ⏭️  ${name}.mp4 ya existe (use --force para regenerar)`);
      success++;
      continue;
    }

    console.log(`   🎬 Generando ${name}.mp4...`);
    const startTime = Date.now();

    try {
      // Determine viewport (PWA is taller)
      const vp = name.includes('25_pwa') ? PWA_VIEWPORT : VIEWPORT;

      // Create temp frames dir for this file
      const framesDir = path.join(TEMP_DIR, name);
      fs.mkdirSync(framesDir, { recursive: true });

      // Open page and capture
      const page = await browser.newPage();
      await page.setViewport(vp);

      const htmlPath = path.join(HTML_DIR, file);
      await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`, {
        waitUntil: 'networkidle0',
        timeout: 30000
      });

      // Wait for animations to initialize
      await new Promise(r => setTimeout(r, 800));

      // Capture frames
      const frameInterval = 1000 / FPS; // ~66.7ms per frame
      for (let i = 0; i < TOTAL_FRAMES; i++) {
        const framePath = path.join(framesDir, `frame_${String(i).padStart(4, '0')}.png`);
        await page.screenshot({ path: framePath, omitBackground: false });

        // Wait for next frame timing
        if (i < TOTAL_FRAMES - 1) {
          await new Promise(r => setTimeout(r, frameInterval));
        }

        // Progress indicator every 30 frames (~2s)
        if ((i + 1) % 30 === 0) {
          process.stdout.write(`      ${Math.round((i + 1) / TOTAL_FRAMES * 100)}%`);
        }
      }
      process.stdout.write('\n');

      await page.close();

      // Convert frames to MP4 via ffmpeg
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(path.join(framesDir, 'frame_%04d.png'))
          .inputFPS(FPS)
          .videoCodec('libx264')
          .outputOptions([
            '-pix_fmt', 'yuv420p',
            '-vf', `scale=${vp.width}:${vp.height}`,
            '-movflags', '+faststart',
            '-preset', 'medium',
            '-crf', '23'
          ])
          .output(outputMp4)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // Cleanup frames
      fs.rmSync(framesDir, { recursive: true });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const sizeKB = Math.round(fs.statSync(outputMp4).size / 1024);
      console.log(`      ✅ ${name}.mp4 — ${sizeKB}KB — ${elapsed}s`);
      success++;

    } catch (err) {
      console.error(`      ❌ ERROR en ${name}: ${err.message}`);
      failed++;
      // Cleanup on error
      const framesDir = path.join(TEMP_DIR, name);
      if (fs.existsSync(framesDir)) fs.rmSync(framesDir, { recursive: true });
    }
  }

  await browser.close();

  // Cleanup temp dir
  try { fs.rmdirSync(TEMP_DIR); } catch {}

  console.log(`\n📊 Resultado: ${success} exitosos, ${failed} fallidos de ${htmlFiles.length} total`);

  if (success > 0) {
    console.log(`📁 MP4s en: ${OUTPUT_DIR}`);
  }
}

main().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});
