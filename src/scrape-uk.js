// UK Legislation Scraper - legislation.gov.uk REST API with full text
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://kdughryizzvgywcpcwpk.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || ''
);

const DOC_TYPE_MAP = {
  'UnitedKingdomPublicGeneralAct': 'act',
  'UnitedKingdomStatutoryInstrument': 'statutory_instrument',
  'ScottishStatutoryInstrument': 'statutory_instrument',
  'WelshStatutoryInstrument': 'statutory_instrument',
  'NorthernIrelandStatutoryRule': 'statutory_rule',
  'ScottishAct': 'act',
  'NorthernIrelandAct': 'act',
  'WelshParliamentAct': 'act',
  'WelshNationalAssemblyAct': 'act',
  'UnitedKingdomLocalAct': 'act',
  'UnitedKingdomChurchMeasure': 'measure',
  'UnitedKingdomChurchInstrument': 'instrument',
  'NorthernIrelandOrderInCouncil': 'order',
  'UnitedKingdomMinisterialOrder': 'order',
  'UnitedKingdomMinisterialDirection': 'direction',
};

async function parseAtomFeed(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    const get = (tag) => {
      const m = entry.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
      return m ? m[1].trim() : null;
    };
    const getAttr = (tag, attr) => {
      const m = entry.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"[^>]*/?>|<${tag}[^>]*${attr}="([^"]*)"[^>]*>`));
      return m ? (m[1] || m[2]) : null;
    };

    const id = get('id');
    const title = get('title');
    const updated = get('updated');
    const published = get('published');
    const summary = get('summary');
    const docType = getAttr('ukm:DocumentMainType', 'Value');
    const year = getAttr('ukm:Year', 'Value');
    const number = getAttr('ukm:Number', 'Value');
    
    // Get the main link (not self)
    const linkMatch = entry.match(/<link(?![^>]*rel="self")[^>]*href="([^"]*)"[^>]*\/?>|<link(?![^>]*rel=)[^>]*href="([^"]*)"[^>]*\/?>/);
    const link = linkMatch ? (linkMatch[1] || linkMatch[2]) : id;

    if (title && id) {
      entries.push({ id, title, updated, published, summary, docType, year, number, link });
    }
  }

  const morePagesMatch = xml.match(/<leg:morePages>(\d+)<\/leg:morePages>/);
  const morePages = morePagesMatch ? parseInt(morePagesMatch[1]) : 0;

  return { entries, morePages };
}

async function fetchPage(page) {
  const url = `https://www.legislation.gov.uk/new/data.feed?page=${page}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/atom+xml' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

/**
 * Fetch full text using the legislation.gov.uk REST API.
 * Uses the XML endpoint for structured data, falls back to HTML.
 * Works for ALL document types — no auth required.
 */
async function fetchLawText(url) {
  try {
    // Normalize URL
    const baseUrl = url.startsWith('http') ? url : `https://www.legislation.gov.uk${url}`;
    
    // Try XML API first — structured, clean data
    const xmlUrl = baseUrl.replace(/\/?$/, '/data.xml');
    const xmlRes = await fetch(xmlUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Accept': 'application/xml',
      },
      redirect: 'follow',
    });

    if (xmlRes.ok) {
      const xml = await xmlRes.text();
      
      // Extract text from legislation body (provisions, sections, articles)
      // Remove metadata section first
      const bodyMatch = xml.match(/<Body[\s\S]*$/i) || xml.match(/<Primary[\s\S]*$/i);
      const bodyXml = bodyMatch ? bodyMatch[0] : xml;
      
      const text = bodyXml
        .replace(/<ukm:Metadata[\s\S]*?<\/ukm:Metadata>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (text.length > 100) {
        return text.slice(0, 50000);
      }
    }

    // Fallback: HTML endpoint
    const htmlUrl = baseUrl.replace(/\/?$/, '/data.htm');
    const htmlRes = await fetch(htmlUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    });

    if (htmlRes.ok) {
      const html = await htmlRes.text();
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return text.slice(0, 50000);
    }

    return '';
  } catch (e) {
    console.error(`  Failed to fetch text for ${url}: ${e.message}`);
    return '';
  }
}

export async function scrapeUK(maxPages = 15) {
  console.log('🇬🇧 Starting UK legislation scrape (REST API with full text for all types)...');
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalWithText = 0;

  for (let page = 1; page <= maxPages; page++) {
    console.log(`  Fetching page ${page}...`);
    const xml = await fetchPage(page);
    const { entries, morePages } = await parseAtomFeed(xml);

    if (entries.length === 0) break;

    for (const entry of entries) {
      // Check if already exists with full text
      const { data: existing } = await supabase
        .from('laws')
        .select('id, full_text_raw')
        .eq('source_url', entry.id)
        .maybeSingle();

      if (existing && existing.full_text_raw) {
        totalSkipped++;
        continue;
      }

      const pubDate = entry.published ? entry.published.split('T')[0] : 
                      entry.updated ? entry.updated.split('T')[0] : null;
      const lawType = DOC_TYPE_MAP[entry.docType] || 'other';

      // Fetch full text for ALL document types via REST API
      let fullText = '';
      if (entry.link) {
        const linkUrl = entry.link.startsWith('http') ? entry.link : `https://www.legislation.gov.uk${entry.link}`;
        console.log(`    Fetching full text: ${entry.title.slice(0, 60)}...`);
        fullText = await fetchLawText(linkUrl);
        if (fullText) totalWithText++;
        // Rate limit — legislation.gov.uk is generous but be polite
        await new Promise(r => setTimeout(r, 400));
      }

      const { error } = await supabase.from('laws').upsert({
        country: 'uk',
        language: 'en',
        source: 'legislation.gov.uk',
        source_url: entry.id,
        published_date: pubDate,
        law_number: entry.number ? `${entry.year}/${entry.number}` : null,
        law_type: lawType,
        title_raw: entry.title,
        full_text_raw: fullText || entry.summary || null,
        document_number: entry.number,
        ai_processed: false,
      }, { onConflict: 'source_url', ignoreDuplicates: false });

      if (error) {
        console.error(`  Error upserting: ${error.message}`);
      } else {
        totalInserted++;
      }
    }

    console.log(`  Page ${page}: ${entries.length} entries, ${totalInserted} inserted, ${totalWithText} with full text`);

    if (page >= morePages + 1) break;
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`🇬🇧 UK scrape complete: ${totalInserted} inserted, ${totalSkipped} skipped, ${totalWithText} with full text`);
  return totalInserted;
}
