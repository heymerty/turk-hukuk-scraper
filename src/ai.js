import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

export async function summarizeLaw(titleRaw, lawType, publishedDate, fullTextRaw) {
  const prompt = `You are analyzing a Turkish official gazette entry.

Title: ${titleRaw}
Type: ${lawType}
Date: ${publishedDate}

Full text (first 12000 chars):
${fullTextRaw.slice(0, 12000)}

Respond ONLY in valid JSON (no markdown, no code fences):
{
  "summary_tr": "3-5 cümlelik sade Türkçe özet (hukuki terimler açıklanarak)",
  "summary_en": "3-5 sentence plain English summary",
  "category": "one of: tax_finance | employment_labor | business_commerce | environment | health | education | infrastructure | security_defense | civil_administrative | judicial | other",
  "impact_level": "high | medium | low",
  "tags": ["keyword1", "keyword2"],
  "key_changes": ["change 1", "change 2"],
  "affected_parties": ["who is affected"]
}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return {
      summary_tr: titleRaw,
      summary_en: titleRaw,
      category: 'other',
      impact_level: 'low',
      tags: [],
      key_changes: [],
      affected_parties: [],
    };
  }
}
