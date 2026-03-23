// EU Legislation Scraper - EUR-Lex SPARQL endpoint + Full Text via HTML
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://kdughryizzvgywcpcwpk.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || ''
);

const SPARQL_ENDPOINT = 'https://publications.europa.eu/webapi/rdf/sparql';

function classifyCelex(celex) {
  if (!celex) return 'other';
  if (/^3\d{4}R/.test(celex) || /R\d{4}/.test(celex)) return 'regulation';
  if (/^3\d{4}L/.test(celex) || /L\d{4}/.test(celex)) return 'directive';
  if (/^3\d{4}D/.test(celex) || /D\d{4}/.test(celex)) return 'decision';
  if (/^C\//.test(celex)) return 'commission_document';
  if (/^6\d{4}C/.test(celex)) return 'judgment';
  if (/^5\d{4}PC/.test(celex)) return 'proposal';
  if (/^5\d{4}/.test(celex)) return 'communication';
  if (/^0\d{4}/.test(celex)) return 'consolidated';
  return 'other';
}

async function sparqlQuery(query) {
  const params = new URLSearchParams();
  params.set('query', query);

  const res = await fetch(SPARQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SPARQL error ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.json();
}

async function fetchEurLexDocuments(sinceDate, offset = 0, limit = 100) {
  const query = `
    PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
    SELECT DISTINCT ?celex ?title ?date WHERE {
      ?work cdm:resource_legal_id_celex ?celex .
      ?work cdm:work_date_document ?date .
      ?exp cdm:expression_belongs_to_work ?work .
      ?exp cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> .
      ?exp cdm:expression_title ?title .
      FILTER(?date >= '${sinceDate}'^^xsd:date)
      FILTER(!STRSTARTS(STR(?celex), "0"))
    } ORDER BY DESC(?date)
    OFFSET ${offset}
    LIMIT ${limit}
  `;
  return await sparqlQuery(query);
}

/**
 * Fetch full text of an EU law from EUR-Lex HTML endpoint.
 * Uses the public HTML rendering — no auth required.
 */
async function fetchEurLexFullText(celex) {
  try {
    const url = `https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:${encodeURIComponent(celex)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Accept': 'text/html',
      },
    });
    if (!res.ok) return '';
    const html = await res.text();

    // Strip scripts, styles, and HTML tags → clean text
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    // Cap at 50KB to avoid Supabase row size issues
    return text.slice(0, 50000);
  } catch (e) {
    console.error(`  Failed to fetch full text for ${celex}: ${e.message}`);
    return '';
  }
}

export async function scrapeEU(daysBack = 60) {
  console.log('🇪🇺 Starting EU legislation scrape (with full text via EUR-Lex HTML)...');
  
  const sinceDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];
  console.log(`  Fetching documents since ${sinceDate}...`);

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalWithText = 0;
  let offset = 0;
  const batchSize = 100;

  while (true) {
    console.log(`  Querying SPARQL offset=${offset}...`);
    const result = await fetchEurLexDocuments(sinceDate, offset, batchSize);
    const bindings = result.results?.bindings || [];

    if (bindings.length === 0) break;

    // Batch prepare records
    const records = [];
    for (const b of bindings) {
      const celex = b.celex?.value;
      const title = b.title?.value;
      const date = b.date?.value;
      if (!celex || !title) continue;

      const sourceUrl = `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:${encodeURIComponent(celex)}`;

      // Check if exists
      const { data: existing } = await supabase
        .from('laws')
        .select('id, full_text_raw')
        .eq('source_url', sourceUrl)
        .maybeSingle();

      // Skip if already has full text
      if (existing && existing.full_text_raw) {
        totalSkipped++;
        continue;
      }

      const lawType = classifyCelex(celex);

      // Fetch full text from EUR-Lex HTML for regulations, directives, decisions
      let fullText = '';
      if (['regulation', 'directive', 'decision'].includes(lawType)) {
        console.log(`    Fetching full text for ${celex}...`);
        fullText = await fetchEurLexFullText(celex);
        if (fullText) totalWithText++;
        // Rate limit to be nice to EUR-Lex
        await new Promise(r => setTimeout(r, 800));
      }

      records.push({
        country: 'eu',
        language: 'en',
        source: 'EUR-Lex',
        source_url: sourceUrl,
        published_date: date,
        document_number: celex,
        law_number: celex,
        law_type: lawType,
        title_raw: title.replace(/\u00A0/g, ' ').replace(/###/g, '').trim(),
        full_text_raw: fullText || null,
        ai_processed: false,
      });
    }

    // Insert in batches of 50
    for (let i = 0; i < records.length; i += 50) {
      const batch = records.slice(i, i + 50);
      if (batch.length === 0) continue;
      const { error } = await supabase.from('laws').upsert(batch, { onConflict: 'source_url', ignoreDuplicates: false });
      if (error) {
        console.error(`  Batch upsert error: ${error.message}`);
        for (const rec of batch) {
          const { error: singleErr } = await supabase.from('laws').upsert(rec, { onConflict: 'source_url', ignoreDuplicates: false });
          if (!singleErr) totalInserted++;
          else console.error(`  Single upsert error: ${singleErr.message}`);
        }
      } else {
        totalInserted += batch.length;
      }
    }

    console.log(`  Processed ${bindings.length} results, ${totalInserted} inserted so far (${totalWithText} with full text)`);

    if (bindings.length < batchSize) break;
    offset += batchSize;
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`🇪🇺 EU scrape complete: ${totalInserted} inserted, ${totalSkipped} skipped, ${totalWithText} with full text`);
  return totalInserted;
}
