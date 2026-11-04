/**
 * rank-core.mjs — 本地排序内核（唯一实现）
 *
 * v3：按评测反馈重写打分层次，修三个已复现问题：
 *
 *   1. 完整名称不确定优先（实测：110 个名称里 40 个没排第一，code-review 第 3）
 *      根因：normalize 只去空白、不去连字符 → 查 "code-review" 时
 *      plain("codereview").startsWith("code-review") 恒为 false。
 *      修复：双向对称规范化（空白/连字符/下划线/点全去），完全相等给最高分。
 *
 *   2. 描述兜底 40 分 < 门槛 60 → 词表外新技能永远搜不到
 *      （实测：新技能描述「用于校准温度传感器」，搜「校准温度」返回空）
 *      修复：描述改为独立通道，90 分起，高于门槛、低于别名。
 *
 *   3. 单字查询被 length<2 一刀切 → 「爬」无结果
 *      修复：单字只认人工维护的单字入口（curated），不无差别放开所有单字。
 *
 * 同时被 verify-*.mjs（验收）与 pack.mjs（内联进浏览器）使用。
 */

export function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[-_.]+/g, '')
    .trim();
}

/** 查询是否含中日韩字符 */
const hasCJK = /[\u4e00-\u9fa5]/;

/**
 * 最长公共子串长度（只用于中文兜底）。
 * 别名是滑窗二元组，没有分词，会产出「写简」「做高」这类碎片；
 * 直接比连续子串，能把「改简历」对上包含「简历」的描述，不依赖词表质量。
 */
function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  const n = Math.min(a.length, 24);
  let best = 0;
  for (let i = 0; i < n; i++) {
    for (let len = best + 1; i + len <= a.length; len++) {
      const seg = a.slice(i, i + len);
      if (b.indexOf(seg) >= 0) {
        if (len > best) best = len;
      } else break;
    }
  }
  return best;
}

/** 描述命中：只做包含判断，不分词 */
function hitsDescription(it, q) {
  const d = it && it.description;
  if (!d) return false;
  return normalize(d).indexOf(q) >= 0;
}

export function rankCandidates(items, query, aliases, opts) {
  const options = opts || {};
  const minScore = options.minScore === undefined ? 60 : options.minScore;
  const limit = options.limit === undefined ? 40 : options.limit;
  const curated = options.curated || {};

  const raw = String(query == null ? '' : query).trim();
  const q = normalize(raw);
  if (!q) return null; // 空查询：调用方走分组逻辑

  const single = q.length === 1;
  const scored = [];

  for (const it of items) {
    if (!it || typeof it.name !== 'string') continue;

    const plain = normalize(it.name);
    const terms = (aliases && aliases[it.name]) || [];
    const curatedTerms = curated[it.name] || [];
    let best = 0;

    // ① 名称：完全相等 > 前缀 > 包含
    if (plain === q) best = 1000;
    else if (plain.startsWith(q)) best = 700;
    else if (!single && plain.indexOf(q) >= 0) best = 400;

    // ② 别名
    for (let i = 0; i < terms.length; i++) {
      const t = normalize(terms[i]);
      if (!t) continue;
      const isCurated = curatedTerms.indexOf(normalize(terms[i])) >= 0;

      let score = 0;
      if (q.indexOf(t) >= 0) {
        if (t.length === 1) {
          if (!isCurated) continue; // 单字只认人工词
          score = 250;
        } else {
          score = (isCurated ? 200 : 120) + t.length * 10;
        }
      } else if (!single && t.indexOf(q) >= 0) {
        score = 100 + q.length * 6;
      }
      if (score > best) best = score;
    }

    // ③ 描述：独立通道，低权重但能过门槛
    if (!single && hitsDescription(it, q)) {
      const d = 90 + Math.min(q.length, 10) * 3;
      if (d > best) best = d;
    }

    // ④ 中文最长公共子串：别名抽词没有分词，会切出「写简」「做高」这种碎片。
    //    直接比连续子串，能把「改简历」对到包含「简历」的描述上，不依赖词表质量。
    if (hasCJK.test(q)) {
      // index.json 用 desc，宿主候选用 description —— 两个都要认
      const descText = normalize(String(it.description || it.desc || ''));
      const lcs = longestCommonSubstring(q, descText);
      if (lcs >= 2) {
        const s = 60 + lcs * 14; // 2 字=88，3 字=102，4 字=116
        if (s > best) best = s;
      }
    }

    if (best >= minScore) scored.push({ it, score: best });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.it.name).localeCompare(String(b.it.name));
  });

  return scored.slice(0, limit).map((s) => s.it);
}
