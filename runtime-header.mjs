// Keep the arrays retained by the host, including additions/removals of chips.
var HEADER_VIEWS = new Map();

function headerItems(query) {
  var catId = matchCat(query);
  if (catId) return [
    { label: '全部 ' + TOTAL, value: 'root' },
    { label: (CATSHORT[catId] || catId) + ' ' + (CATCOUNT[catId] || 0), value: 'cat:' + catId, current: true }
  ];
  var ids = Object.keys(CATCOUNT).filter(function (id) { return CATCOUNT[id] > 0; });
  ids.sort(function (a, b) { return (CATS[a] ? CATS[a].order : 999) - (CATS[b] ? CATS[b].order : 999); });
  var chips = ids.map(function (id) { return { label: (CATSHORT[id] || id) + ' ' + CATCOUNT[id], value: 'cat:' + id }; });
  // 索引与目录不一致的自证不放在这里：菜单里的数字会被外部脚本（含验收集）
  // 当成计数累加，多一个芯片就会让「合计」变成 NaN 或双倍。取证走
  // dsh.skillcat.diag 与宿主日志，界面只显示真实的分类与条数。
  // The host discards empty arrays. Retain a placeholder so an initially empty
  // catalog can populate its first categories during this same menu opening.
  return chips.length ? chips : [{ label: '全部 0', value: 'root', current: true }];
}

function buildHeader(session, ctx) {
  var query = ctx && typeof ctx.query === 'string' ? ctx.query : '';
  var crumbs = headerItems(query);
  HEADER_VIEWS.set(sid(session), { query: query, crumbs: crumbs });
  return crumbs;
}

function syncCrumbs(session) {
  var view = HEADER_VIEWS.get(sid(session));
  if (!view) return;
  var next = headerItems(view.query);
  var previous = new Map(view.crumbs.map(function (c) { return [c.value, c]; }));
  next = next.map(function (c) {
    var old = previous.get(c.value);
    if (!old) return c;
    old.label = c.label;
    if (c.current) old.current = true; else delete old.current;
    return old;
  });
  view.crumbs.splice.apply(view.crumbs, [0, view.crumbs.length].concat(next));
  diag.crumbsSynced = (diag.crumbsSynced || 0) + 1;
}
