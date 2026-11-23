// Порядок блюд внутри категории (одинаковый на сайте для клиентов и в админке).
// Блюда делятся по ключевым словам в названии на группы; группы идут в заданном порядке,
// внутри группы остаётся прежний порядок (как в меню iiko). Блюдо без ключевых слов попадает в первую группу.
(function (root) {
  var RULES = [
    // «Салаты и боул»: сначала салаты, потом боулы, бибимпаб, поке
    { cat: /салат/i, groups: [/боул|бол\b|bowl/i, /пибимпаб|бибимпаб|бибимбап|пибимбап/i, /поке|poke/i] },
    // «Завтраки и супы»: разные завтраки, творожный боул, блины, сырники, каша, суп дня
    { cat: /завтрак/i, groups: [/творожн\S*\s+боул/i, /блин/i, /сырник/i, /каш[аи]/i, /суп|борщ|крем[-\s]/i] }
  ];
  function rank(rule, name) {
    for (var i = 0; i < rule.groups.length; i++) if (rule.groups[i].test(name)) return i + 1;
    return 0;
  }
  // items: массив объектов с полем name; возвращает новый массив (порядок внутри группы сохраняется)
  function sortItems(catName, items) {
    var rule = null;
    for (var i = 0; i < RULES.length; i++) if (RULES[i].cat.test(String(catName || ''))) { rule = RULES[i]; break; }
    if (!rule) return items.slice();
    return items.map(function (it, k) { return { it: it, r: rank(rule, String(it.name || '')), k: k }; })
      .sort(function (a, b) { return a.r - b.r || a.k - b.k; })
      .map(function (x) { return x.it; });
  }
  root.MenuOrder = { sortItems: sortItems };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.MenuOrder;
})(typeof window !== 'undefined' ? window : globalThis);
