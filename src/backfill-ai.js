import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import * as iconv from 'iconv-lite';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://kdughryizzvgywcpcwpk.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || ''
);

async function fetchAndDecode(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TurkHukukMonitor/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return iconv.decode(buffer, 'windows-1254');
}

async function fetchArticleText(url) {
  try {
    const html = await fetchAndDecode(url);
    const $ = cheerio.load(html);
    $('script, style, nav, header, footer').remove();
    const text = $('body').text().replace(/\s+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
    return text.slice(0, 15000);
  } catch (e) {
    console.error(`  Failed to fetch ${url}: ${e.message}`);
    return '';
  }
}

function categorizeFromTitle(title, lawType) {
  const t = title.toUpperCase();
  
  if (t.includes('VERGİ') || t.includes('BÜTÇE') || t.includes('MALİ') || t.includes('GELİR') || t.includes('GÜMRÜK') || t.includes('HARÇ') || t.includes('KDV'))
    return 'tax_finance';
  if (t.includes('İŞ KANUN') || t.includes('İSTİHDAM') || t.includes('SENDİKA') || t.includes('ÇALIŞAN') || t.includes('İŞÇİ') || t.includes('SÖZLEŞMELİ PERSONEL') || t.includes('MEMUR'))
    return 'employment_labor';
  if (t.includes('TİCARET') || t.includes('ŞİRKET') || t.includes('BANKA') || t.includes('SİGORTA') || t.includes('SERMAYE') || t.includes('ÖZELLEŞTİRME') || t.includes('İHALE'))
    return 'business_commerce';
  if (t.includes('ÇEVRE') || t.includes('PARK') || t.includes('ORMAN') || t.includes('SU') || t.includes('DOĞA') || t.includes('ARAZİ'))
    return 'environment';
  if (t.includes('SAĞLIK') || t.includes('İLAÇ') || t.includes('HASTANESİ') || t.includes('TIP'))
    return 'health';
  if (t.includes('EĞİTİM') || t.includes('ÜNİVERSİTE') || t.includes('FAKÜLTE') || t.includes('OKUL'))
    return 'education';
  if (t.includes('ULAŞIM') || t.includes('YAPI') || t.includes('İMAR') || t.includes('RAYLI') || t.includes('PROJE') || t.includes('ENERJİ'))
    return 'infrastructure';
  if (t.includes('GÜVENLİK') || t.includes('SAVUNMA') || t.includes('SİBER') || t.includes('TSK') || t.includes('MİLLÎ'))
    return 'security_defense';
  if (t.includes('ANAYASA') || t.includes('YARGI') || t.includes('MAHKEME') || t.includes('HUKUK'))
    return 'judicial';
  if (t.includes('KAMU') || t.includes('İDARE') || t.includes('KURUL') || t.includes('ATAMA') || t.includes('TEŞKİLAT'))
    return 'civil_administrative';
  
  // By law type
  if (lawType === 'aym') return 'judicial';
  if (lawType === 'kanun') return 'civil_administrative';
  if (lawType === 'yonetmelik') return 'civil_administrative';
  if (lawType === 'cbk' || lawType === 'cbkarar') return 'civil_administrative';
  
  return 'other';
}

function determineImpact(title, lawType) {
  const t = title.toUpperCase();
  
  if (lawType === 'kanun') return 'high';
  if (lawType === 'cbk') return 'high';
  if (t.includes('KANUN') && !t.includes('KANUN HÜKMÜNDE') === false) return 'high';
  if (t.includes('DEĞİŞİKLİK')) return 'medium';
  if (t.includes('TEBLİĞ')) return 'medium';
  if (lawType === 'aym' && t.includes('SİYASİ PARTİ MALİ DENETİMİ')) return 'low';
  if (lawType === 'aym') return 'medium';
  if (lawType === 'yonetmelik') return 'medium';
  if (t.includes('İLAN') || t.includes('DUYURU')) return 'low';
  
  return 'low';
}

const lawTypeNames = {
  kanun: 'Kanun (Law)',
  cbk: 'Cumhurbaşkanlığı Kararnamesi (Presidential Decree)',
  cbkarar: 'Cumhurbaşkanı Kararı (Presidential Decision)',
  yonetmelik: 'Yönetmelik (Regulation)',
  teblig: 'Tebliğ (Communiqué)',
  aym: 'Anayasa Mahkemesi Kararı (Constitutional Court Decision)',
  kurul_karar: 'Kurul Kararı (Board Decision)',
  other: 'Resmi Gazete İlanı (Official Gazette Entry)',
};

function generateSummaries(title, lawType, textContent) {
  const cleanTitle = title.replace(/\s+/g, ' ').replace(/^[–\s]+/, '').trim();
  const typeName = lawTypeNames[lawType] || lawTypeNames.other;
  
  // Extract key info from text if available
  let extraContext = '';
  if (textContent && textContent.length > 100) {
    // Get first meaningful paragraph
    const firstChunk = textContent.slice(0, 500).replace(/\s+/g, ' ');
    extraContext = firstChunk;
  }
  
  // Generate Turkish summary
  let summary_tr = '';
  let summary_en = '';
  
  if (lawType === 'aym' && cleanTitle.includes('Siyasi Parti Mali Denetimi')) {
    const partyMatch = cleanTitle.match(/E:\s*(\d{4}\/\d+).*K:\s*(\d{4}\/\d+)/);
    const caseNum = partyMatch ? `${partyMatch[1]}` : '';
    summary_tr = `Anayasa Mahkemesi'nin siyasi parti mali denetimi kararıdır (${caseNum}). Siyasi partilerin mali faaliyetlerinin anayasal denetime tabi tutulmasına ilişkin karardır.`;
    summary_en = `Constitutional Court decision on political party financial audit (${caseNum}). This decision concerns the constitutional review of political party financial activities.`;
  } else if (lawType === 'aym') {
    const caseMatch = cleanTitle.match(/E:\s*([\d\/]+).*K:\s*([\d\/]+)/);
    const caseRef = caseMatch ? ` (E: ${caseMatch[1]}, K: ${caseMatch[2]})` : '';
    summary_tr = `Anayasa Mahkemesi kararıdır${caseRef}. ${cleanTitle.includes('İptal') ? 'Kanun maddelerinin anayasaya uygunluğunun denetlendiği karardır.' : 'Anayasal denetim kapsamında verilen karardır.'}`;
    summary_en = `Constitutional Court decision${caseRef}. ${cleanTitle.includes('İptal') ? 'This decision reviews the constitutionality of legal provisions.' : 'This is a decision within the scope of constitutional review.'}`;
  } else if (lawType === 'kanun') {
    summary_tr = `${cleanTitle}. Bu kanun Resmi Gazete'de yayımlanarak yürürlüğe girmiştir.`;
    summary_en = `${cleanTitle}. This law has been published in the Official Gazette and entered into force.`;
  } else if (lawType === 'cbk' || lawType === 'cbkarar') {
    summary_tr = `Cumhurbaşkanlığı kararıdır: ${cleanTitle}. Resmi Gazete'de yayımlanmıştır.`;
    summary_en = `Presidential decision: ${cleanTitle}. Published in the Official Gazette.`;
  } else if (lawType === 'yonetmelik') {
    summary_tr = `Yönetmelik: ${cleanTitle}. Bu yönetmelik Resmi Gazete'de yayımlanarak yürürlüğe girmiştir.`;
    summary_en = `Regulation: ${cleanTitle}. This regulation has been published in the Official Gazette and entered into force.`;
  } else if (lawType === 'teblig') {
    summary_tr = `Tebliğ: ${cleanTitle}. İlgili kurum tarafından yayımlanan düzenleyici işlemdir.`;
    summary_en = `Communiqué: ${cleanTitle}. This is a regulatory action published by the relevant authority.`;
  } else {
    summary_tr = `${cleanTitle}. Resmi Gazete'de yayımlanan düzenlemedir.`;
    summary_en = `${cleanTitle}. Published in the Turkish Official Gazette.`;
  }
  
  // Generate tags from title
  const tags = [];
  const tagKeywords = {
    'kanun': 'kanun', 'yönetmelik': 'yönetmelik', 'tebliğ': 'tebliğ',
    'değişiklik': 'değişiklik', 'anayasa': 'anayasa', 'mahkeme': 'mahkeme',
    'vergi': 'vergi', 'banka': 'bankacılık', 'ticaret': 'ticaret',
    'enerji': 'enerji', 'sağlık': 'sağlık', 'eğitim': 'eğitim',
    'güvenlik': 'güvenlik', 'siber': 'siber güvenlik', 'üniversite': 'üniversite',
    'özelleştirme': 'özelleştirme', 'ihale': 'ihale', 'ithalat': 'ithalat',
    'park': 'çevre', 'arazi': 'arazi', 'atama': 'atama',
  };
  
  const titleLower = cleanTitle.toLowerCase();
  for (const [key, tag] of Object.entries(tagKeywords)) {
    if (titleLower.includes(key) && !tags.includes(tag)) tags.push(tag);
  }
  if (tags.length === 0) tags.push(lawType);
  
  return {
    summary_tr: summary_tr.slice(0, 1000),
    summary_en: summary_en.slice(0, 1000),
    category: categorizeFromTitle(cleanTitle, lawType),
    impact_level: determineImpact(cleanTitle, lawType),
    tags: tags.slice(0, 5),
    key_changes: [cleanTitle.slice(0, 200)],
    affected_parties: determineAffectedParties(cleanTitle, lawType),
  };
}

function determineAffectedParties(title, lawType) {
  const parties = [];
  const t = title.toUpperCase();
  
  if (t.includes('KAMU') || t.includes('MEMUR') || t.includes('PERSONEL')) parties.push('Kamu çalışanları');
  if (t.includes('ÜNİVERSİTE') || t.includes('FAKÜLTE')) parties.push('Üniversiteler ve öğrenciler');
  if (t.includes('BANKA') || t.includes('SİGORTA')) parties.push('Finans sektörü');
  if (t.includes('İTHALAT') || t.includes('İHRACAT') || t.includes('TİCARET')) parties.push('İthalatçılar ve ihracatçılar');
  if (t.includes('ENERJİ')) parties.push('Enerji sektörü');
  if (t.includes('SİYASİ PARTİ')) parties.push('Siyasi partiler');
  if (lawType === 'kanun') parties.push('Genel kamu');
  if (lawType === 'aym') parties.push('Yargı sistemi');
  
  if (parties.length === 0) parties.push('İlgili kamu kurumları');
  return parties.slice(0, 3);
}

async function main() {
  const BATCH_SIZE = 10;
  const TOTAL_LIMIT = 50;

  console.log('🔄 Fetching unprocessed laws from Supabase...');

  const { data: laws, error } = await supabase
    .from('laws')
    .select('*')
    .eq('ai_processed', false)
    .order('published_date', { ascending: false })
    .limit(TOTAL_LIMIT);

  if (error) {
    console.error('Error fetching laws:', error.message);
    process.exit(1);
  }

  console.log(`Found ${laws.length} unprocessed laws`);

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < laws.length; i += BATCH_SIZE) {
    const batch = laws.slice(i, i + BATCH_SIZE);
    console.log(`\n--- Batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} laws) ---`);

    for (const law of batch) {
      try {
        const shortTitle = (law.title_raw || '').replace(/\s+/g, ' ').slice(0, 80);
        console.log(`  Processing: ${shortTitle}...`);

        // Get text content for HTML articles
        let textContent = law.full_text_raw || '';

        if (!textContent && !law.is_pdf && law.source_url && law.source_url.endsWith('.htm')) {
          console.log(`  Fetching HTML...`);
          textContent = await fetchArticleText(law.source_url);
          await new Promise(r => setTimeout(r, 300));
        }

        if (!textContent && law.is_pdf) {
          textContent = law.title_raw || '';
        }

        // Generate summaries from title + text
        const summary = generateSummaries(law.title_raw || '', law.law_type, textContent);

        // Update DB
        const updateData = {
          summary_tr: summary.summary_tr,
          summary_en: summary.summary_en,
          category: summary.category,
          impact_level: summary.impact_level,
          tags: summary.tags,
          key_changes: summary.key_changes,
          affected_parties: summary.affected_parties,
          ai_processed: true,
          ai_processed_at: new Date().toISOString(),
          ai_model: 'rule-based-v1',
        };

        if (textContent && !law.full_text_raw) {
          updateData.full_text_raw = textContent;
        }

        const { error: updateErr } = await supabase
          .from('laws')
          .update(updateData)
          .eq('id', law.id);

        if (updateErr) {
          console.error(`  ❌ Update error: ${updateErr.message}`);
          failed++;
        } else {
          processed++;
          console.log(`  ✅ Done (${processed}/${laws.length}) [${summary.category}/${summary.impact_level}]`);
        }
      } catch (e) {
        console.error(`  ❌ Error: ${e.message}`);
        failed++;
      }
    }

    if (i + BATCH_SIZE < laws.length) {
      console.log('  ⏳ Batch delay...');
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`\n✅ Complete: ${processed} processed, ${failed} failed out of ${laws.length}`);
  
  // Verify
  const { count } = await supabase
    .from('laws')
    .select('*', { count: 'exact', head: true })
    .eq('ai_processed', true);
  
  console.log(`📊 Total ai_processed=true laws in DB: ${count}`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
