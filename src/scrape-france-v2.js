// France Legislation Scraper v2 - DILA Open Data with full text extraction
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://kdughryizzvgywcpcwpk.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || ''
);

const DILA_BASE = 'https://echanges.dila.gouv.fr/OPENDATA/JORF/';
const TMP_DIR = '/tmp/jorf_scrape_v2';

async function getAvailableFiles(daysBack = 30) {
  const res = await fetch(DILA_BASE, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Failed to list DILA: ${res.status}`);
  const html = await res.text();

  const fileRegex = /href="(JORF_(\d{8})-\d{6}\.tar\.gz)"/g;
  const files = [];
  let match;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffStr = cutoff.toISOString().slice(0, 10).replace(/-/g, '');

  while ((match = fileRegex.exec(html)) !== null) {
    const filename = match[1];
    const dateStr = match[2];
    if (dateStr >= cutoffStr) files.push({ filename, dateStr });
  }
  files.sort((a, b) => b.dateStr.localeCompare(a.dateStr));
  return files;
}

async function downloadAndExtract(filename) {
  const dir = join(TMP_DIR, filename.replace('.tar.gz', ''));
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  try {
    execSync(`curl -sL "${DILA_BASE}${filename}" | tar xz -C "${dir}" 2>/dev/null`, { timeout: 60000 });
    return dir;
  } catch (e) {
    console.error(`  Failed to download ${filename}: ${e.message}`);
    return null;
  }
}

function findXMLFiles(dir, subpath = '') {
  const results = [];
  try {
    const items = readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const path = join(dir, item.name);
      if (item.isDirectory()) {
        results.push(...findXMLFiles(path, subpath));
      } else if (item.name.endsWith('.xml') && path.includes(subpath)) {
        results.push(path);
      }
    }
  } catch (e) { /* ignore */ }
  return results;
}

/**
 * Parse article XML files to extract unique law entries with real titles AND full text.
 * Each article has a CONTEXTE/TEXTE element with TITRE_TXT and attributes,
 * plus BLOC_TEXTUEL/CONTENU with the actual article text.
 */
function parseLawsFromArticles(articleXmlFiles) {
  const lawsMap = new Map(); // keyed by JORFTEXT id

  for (const xmlPath of articleXmlFiles) {
    try {
      const content = readFileSync(xmlPath, 'utf-8');

      // Get the CONTEXTE/TEXTE block
      const contexteMatch = content.match(/<CONTEXTE>([\s\S]*?)<\/CONTEXTE>/);
      if (!contexteMatch) continue;
      const contexte = contexteMatch[1];

      // Get TEXTE attributes
      const texteMatch = contexte.match(/<TEXTE ([^>]+)>/);
      if (!texteMatch) continue;
      const texteAttrs = texteMatch[1];

      const getAttrFromStr = (str, attr) => {
        const m = str.match(new RegExp(`${attr}="([^"]*)"`));
        return m ? m[1] : null;
      };

      const cid = getAttrFromStr(texteAttrs, 'cid');
      if (!cid) continue;

      // Get TITRE_TXT (longest one, which has the full title)
      const titreTxtMatches = [...contexte.matchAll(/<TITRE_TXT[^>]*>([^<]+)<\/TITRE_TXT>/g)];
      if (titreTxtMatches.length === 0) continue;
      const titre = titreTxtMatches.reduce((a, b) => a[1].length >= b[1].length ? a : b)[1].trim();
      if (!titre || titre.length < 5) continue;

      // Extract article text from BLOC_TEXTUEL/CONTENU
      const blocMatch = content.match(/<BLOC_TEXTUEL>\s*<CONTENU>([\s\S]*?)<\/CONTENU>\s*<\/BLOC_TEXTUEL>/);
      let articleText = '';
      if (blocMatch) {
        articleText = blocMatch[1]
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\s+/g, ' ')
          .trim();
      }

      // Get article number for ordering
      const numMatch = content.match(/<NUM>([^<]*)<\/NUM>/);
      const articleNum = numMatch ? numMatch[1].trim() : '';

      if (!lawsMap.has(cid)) {
        const nature = getAttrFromStr(texteAttrs, 'nature') || '';
        const nor = getAttrFromStr(texteAttrs, 'nor') || '';
        const num = getAttrFromStr(texteAttrs, 'num') || '';
        const datePubli = getAttrFromStr(texteAttrs, 'date_publi') || '';

        lawsMap.set(cid, {
          cid, titre, nature, nor, num, datePubli,
          articles: [],
        });
      }

      // Accumulate article text
      if (articleText) {
        lawsMap.get(cid).articles.push({
          num: articleNum,
          text: articleText,
        });
      }
    } catch (e) { /* skip */ }
  }

  // Build full text from accumulated articles
  const results = [];
  for (const law of lawsMap.values()) {
    // Sort articles by number (numeric if possible)
    law.articles.sort((a, b) => {
      const na = parseInt(a.num) || 0;
      const nb = parseInt(b.num) || 0;
      return na - nb;
    });

    let fullText = '';
    if (law.articles.length > 0) {
      fullText = law.articles
        .map(a => a.num ? `Article ${a.num}: ${a.text}` : a.text)
        .join('\n\n');
    }

    // Cap at 50KB
    if (fullText.length > 50000) fullText = fullText.slice(0, 50000);

    results.push({
      cid: law.cid,
      titre: law.titre,
      nature: law.nature,
      nor: law.nor,
      num: law.num,
      datePubli: law.datePubli,
      fullText: fullText || null,
    });
  }

  return results;
}

function classifyFrenchLaw(nature) {
  const n = (nature || '').toUpperCase();
  if (n.includes('LOI')) return 'loi';
  if (n.includes('DECRET') || n.includes('DÉCRET')) return 'decret';
  if (n.includes('ARRETE') || n.includes('ARRÊTÉ')) return 'arrete';
  if (n.includes('ORDONNANCE')) return 'ordonnance';
  if (n.includes('CIRCULAIRE')) return 'circulaire';
  if (n.includes('AVIS')) return 'avis';
  if (n.includes('DECISION') || n.includes('DÉCISION')) return 'decision';
  return 'other';
}

export async function scrapeFranceV2(daysBack = 30) {
  console.log('🇫🇷 Starting France JORF v2 scrape (with full text from article XMLs)...');

  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });

  const files = await getAvailableFiles(daysBack);
  // Prefer evening files (more complete)
  const eveningFiles = files.filter(f => {
    const time = f.filename.match(/-(\d{6})\./)?.[1];
    return time && parseInt(time) > 200000;
  });
  const targetFiles = eveningFiles.length > 5 ? eveningFiles : files;
  console.log(`  Processing ${targetFiles.length} JORF tarballs...`);

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalWithText = 0;

  for (const file of targetFiles) {
    const dateStr = `${file.dateStr.slice(0,4)}-${file.dateStr.slice(4,6)}-${file.dateStr.slice(6,8)}`;
    console.log(`  Processing ${file.filename}...`);

    const dir = await downloadAndExtract(file.filename);
    if (!dir) continue;

    // Find article XMLs (these have real titles + text content)
    const articleFiles = findXMLFiles(dir, '/article/');
    if (articleFiles.length === 0) {
      try { rmSync(dir, { recursive: true }); } catch(e) {}
      continue;
    }

    const laws = parseLawsFromArticles(articleFiles);
    console.log(`    Found ${laws.length} unique laws from ${articleFiles.length} articles`);

    for (const law of laws) {
      if (!law.titre || law.titre.length < 10) continue;

      const sourceUrl = `https://www.legifrance.gouv.fr/jorf/id/${law.cid}`;

      const { data: existing } = await supabase
        .from('laws')
        .select('id, full_text_raw')
        .eq('source_url', sourceUrl)
        .maybeSingle();

      // Skip if already has full text
      if (existing && existing.full_text_raw) { totalSkipped++; continue; }

      const lawType = classifyFrenchLaw(law.nature);
      const pubDate = law.datePubli || dateStr;

      if (law.fullText) totalWithText++;

      const { error } = await supabase.from('laws').upsert({
        country: 'france',
        language: 'fr',
        source: 'Journal Officiel (DILA)',
        source_url: sourceUrl,
        published_date: pubDate,
        document_number: law.cid || null,
        law_number: law.num || law.nor || null,
        law_type: lawType,
        title_raw: law.titre,
        full_text_raw: law.fullText,
        ai_processed: false,
      }, { onConflict: 'source_url', ignoreDuplicates: false });

      if (error) {
        if (!error.message.includes('duplicate')) {
          console.error(`  Insert error: ${error.message}`);
        }
      } else {
        totalInserted++;
      }
    }

    try { rmSync(dir, { recursive: true }); } catch(e) {}
    await new Promise(r => setTimeout(r, 300));
  }

  try { rmSync(TMP_DIR, { recursive: true }); } catch(e) {}

  console.log(`🇫🇷 France v2 scrape complete: ${totalInserted} inserted, ${totalSkipped} skipped, ${totalWithText} with full text`);
  return totalInserted;
}
