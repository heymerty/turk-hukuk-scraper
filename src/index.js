import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';
import { scrapeGazetteIndex, fetchArticleText, formatDateStr, getDateRange } from './scraper.js';
import { summarizeLaw } from './ai.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function scrapeDate(dateStr) {
  const publishedDate = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;

  // Check if already scraped
  const { data: existing } = await supabase
    .from('gazette_issues')
    .select('id')
    .eq('published_date', publishedDate)
    .maybeSingle();

  if (existing) {
    console.log(`[${dateStr}] Already scraped, skipping`);
    return { date: dateStr, items: 0, status: 'already_scraped' };
  }

  const issue = await scrapeGazetteIndex(dateStr);

  if (!issue.items.length) {
    console.log(`[${dateStr}] No items (holiday or non-publish day)`);
    return { date: dateStr, items: 0, status: 'no_items' };
  }

  // Insert gazette issue
  const { data: issueRow, error: issueErr } = await supabase
    .from('gazette_issues')
    .insert({
      issue_number: issue.issueNumber || 0,
      published_date: publishedDate,
      index_url: issue.indexUrl,
      pdf_url: issue.pdfUrl,
      item_count: issue.items.length,
    })
    .select('id')
    .single();

  if (issueErr) {
    console.error(`[${dateStr}] Issue insert error:`, issueErr.message);
    return { date: dateStr, items: 0, status: `error: ${issueErr.message}` };
  }

  let insertedCount = 0;

  for (const item of issue.items) {
    // Check if law already exists
    const { data: existingLaw } = await supabase
      .from('laws')
      .select('id')
      .eq('source_url', item.url)
      .maybeSingle();

    if (existingLaw) continue;

    // Fetch article text for .htm files
    let fullText = '';
    if (!item.isPdf) {
      fullText = await fetchArticleText(item.url);
      await new Promise(r => setTimeout(r, 500));
    }

    // Extract law number if kanun
    let lawNumber = null;
    if (item.lawType === 'kanun') {
      const match = item.title.match(/(\d{4,5})\s*Say/);
      if (match) lawNumber = match[1];
    }

    const { error: lawErr } = await supabase
      .from('laws')
      .insert({
        gazette_issue_id: issueRow.id,
        source_url: item.url,
        is_pdf: item.isPdf,
        gazette_number: issue.issueNumber || 0,
        published_date: publishedDate,
        law_number: lawNumber,
        law_type: item.lawType,
        title_raw: item.title,
        full_text_raw: fullText || null,
        ai_processed: false,
      });

    if (!lawErr) insertedCount++;
    else console.error(`[${dateStr}] Law insert error:`, lawErr.message);
  }

  console.log(`[${dateStr}] Scraped ${insertedCount} items`);
  return { date: dateStr, items: insertedCount, status: 'scraped' };
}

async function processUnprocessedLaws(limit = 20) {
  // Fetch ALL unprocessed laws (including PDFs with null full_text_raw)
  const { data: laws, error } = await supabase
    .from('laws')
    .select('*')
    .eq('ai_processed', false)
    .order('published_date', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error fetching unprocessed laws:', error.message);
    return;
  }

  if (!laws || laws.length === 0) {
    console.log('No unprocessed laws to summarize');
    return;
  }

  console.log(`Processing ${laws.length} laws with AI...`);

  let processed = 0;
  for (const law of laws) {
    try {
      const textContent = law.full_text_raw || law.title_raw || '';
      const summary = await summarizeLaw(
        law.title_raw,
        law.law_type,
        law.published_date,
        textContent
      );

      const { error: updateErr } = await supabase
        .from('laws')
        .update({
          summary_tr: summary.summary_tr,
          summary_en: summary.summary_en,
          category: summary.category,
          impact_level: summary.impact_level,
          tags: summary.tags,
          key_changes: summary.key_changes,
          affected_parties: summary.affected_parties,
          ai_processed: true,
          ai_processed_at: new Date().toISOString(),
          ai_model: 'claude-sonnet-4-5-20250514',
        })
        .eq('id', law.id);

      if (updateErr) {
        console.error(`AI update error for ${law.id}:`, updateErr.message);
      } else {
        processed++;
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`AI error for ${law.id}:`, e.message);
    }
  }

  console.log(`AI processing complete: ${processed}/${laws.length}`);
}

async function runBackfill() {
  console.log('=== Starting backfill: 2026-01-01 → today ===');
  const start = new Date('2026-01-01');
  const end = new Date();
  const dates = getDateRange(start, end);
  console.log(`Total dates to process: ${dates.length}`);

  let scraped = 0, skipped = 0, errors = 0;

  for (const dateStr of dates) {
    try {
      const result = await scrapeDate(dateStr);
      if (result.status === 'scraped') scraped++;
      else if (result.status === 'already_scraped') skipped++;
      // Rate limit between dates
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error(`[${dateStr}] Error:`, e.message);
      errors++;
    }
  }

  console.log(`=== Backfill complete: scraped=${scraped}, skipped=${skipped}, errors=${errors} ===`);

  // Process AI summaries after backfill
  console.log('=== Running AI processing after backfill ===');
  await processUnprocessedLaws(50);
}

async function runDaily() {
  console.log(`=== Daily scrape: ${new Date().toISOString()} ===`);
  const now = new Date();
  const turkeyTime = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const dateStr = formatDateStr(turkeyTime);

  try {
    await scrapeDate(dateStr);
    await processUnprocessedLaws(30);
  } catch (e) {
    console.error('Daily scrape error:', e.message);
  }
}

// Main
async function main() {
  console.log('🇹🇷 Türk Hukuk Scraper starting...');
  console.log(`Supabase URL: ${process.env.SUPABASE_URL}`);
  console.log(`Time: ${new Date().toISOString()}`);

  // Run backfill first
  await runBackfill();

  // Schedule daily at 06:00 UTC (09:00 Turkey time)
  cron.schedule('0 6 * * *', runDaily, { timezone: 'UTC' });
  console.log('✅ Daily cron scheduled: 06:00 UTC');

  // Keep process alive
  console.log('Scraper running. Waiting for next cron...');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
