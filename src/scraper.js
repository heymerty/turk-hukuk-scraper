import * as cheerio from 'cheerio';
import * as iconv from 'iconv-lite';

const BASE_URL = 'https://www.resmigazete.gov.tr';

function determineLawType(sectionTitle, itemTitle) {
  const s = sectionTitle.toUpperCase();
  const t = itemTitle.toUpperCase();

  if (s.includes('YASAMA') || t.includes('KANUN')) return 'kanun';
  if (t.includes('CUMHURBAŞKANLIĞI KARARNAMESİ') || t.includes('CUMHURBAŞKANLIĞI KARARNAMES')) return 'cbk';
  if (t.includes('CUMHURBAŞKANI KARARI') || t.includes('CUMHURBAŞKANI KARAR')) return 'cbkarar';
  if (t.includes('YÖNETMELİK') || t.includes('YÖNETMEL')) return 'yonetmelik';
  if (t.includes('TEBLİĞ') || t.includes('TEBL')) return 'teblig';
  if (t.includes('ANAYASA MAHKEMESİ') || t.includes('ANAYASA MAHKEMES')) return 'aym';
  if (t.includes('KURUL KARARI') || t.includes('KURUL KARAR')) return 'kurul_karar';
  if (s.includes('YARGI')) return 'aym';
  if (s.includes('İLAN') || s.includes('ILAN')) return 'ilan';
  return 'other';
}

async function fetchAndDecode(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return iconv.decode(buffer, 'windows-1254');
}

export async function scrapeGazetteIndex(dateStr) {
  const yyyy = dateStr.slice(0, 4);
  const mm = dateStr.slice(4, 6);
  const indexUrl = `${BASE_URL}/eskiler/${yyyy}/${mm}/${dateStr}.htm`;
  const pdfUrl = `${BASE_URL}/eskiler/${yyyy}/${mm}/${dateStr}.pdf`;

  const html = await fetchAndDecode(indexUrl);

  if (html.includes('yayımlanmamaktadır') || html.includes('yayimlanmamaktadir')) {
    return { issueNumber: null, date: dateStr, indexUrl, pdfUrl, items: [] };
  }

  const $ = cheerio.load(html);

  let issueNumber = null;
  const headingText = $('body').text();
  const sayiMatch = headingText.match(/Say[ıi]\s*[:=]\s*(\d+)/);
  if (sayiMatch) issueNumber = parseInt(sayiMatch[1]);

  const items = [];
  let currentSection = '';

  $('a').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (!href || !text) return;
    if (href.startsWith('#') || href.startsWith('javascript:') || href === '/') return;

    if (text.includes('BÖLÜMÜ') || text.includes('BÖLÜM')) {
      currentSection = text;
      return;
    }

    let fullUrl = href;
    if (!href.startsWith('http')) {
      fullUrl = `${BASE_URL}/eskiler/${yyyy}/${mm}/${href}`;
    }

    const isPdf = href.endsWith('.pdf');
    const lawType = determineLawType(currentSection, text);
    if (lawType === 'ilan') return;

    items.push({ title: text, url: fullUrl, lawType, isPdf });
  });

  return { issueNumber, date: dateStr, indexUrl, pdfUrl, items };
}

export async function fetchArticleText(url) {
  try {
    const html = await fetchAndDecode(url);
    const $ = cheerio.load(html);
    $('script, style, nav, header, footer').remove();
    const text = $('body').text().replace(/\s+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
    return text.slice(0, 15000);
  } catch (e) {
    console.error(`Failed to fetch article: ${url}`, e.message);
    return '';
  }
}

export function formatDateStr(date) {
  const yyyy = date.getFullYear().toString();
  const mm = (date.getMonth() + 1).toString().padStart(2, '0');
  const dd = date.getDate().toString().padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

export function getDateRange(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate);
  while (current <= endDate) {
    dates.push(formatDateStr(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}
