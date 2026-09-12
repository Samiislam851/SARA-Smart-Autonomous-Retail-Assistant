/*!
 * agent.js — drop-in behavioral agent embed. Vanilla JS, no deps, ES2019, IIFE.
 * <script src=".../agent.js" data-server="https://SERVER" data-panel="true"
 *         data-site="bookstore" data-targets="auto" defer></script>
 *
 * Event/Action contract mirrors server/contracts.js — do not diverge.
 * The agent never touches the DOM directly: only the allow-listed executor
 * below does, and only via classList/style toggles + textContent. No eval,
 * no innerHTML from server strings, no auto-click/fill/navigate.
 *
 * Cart events (cart_view / cart_update) only fire if the host page exposes
 * window.__agentCart = {total, items} or an element matching
 * [data-agent-cart-total]. Pages that expose neither simply never emit
 * cart events — this is intentional, not a bug.
 *
 * Facts extraction (data-facts="keys|snippets|both|off", default "both"):
 * reads the page like a shopper would — no wiring required. See
 * extractFactsFrom() below and server/FACTS.md. If the page exposes no
 * explicit cart source (window.__agentCart / [data-agent-cart-total]) but
 * facts detect a cart_total, cart_view/cart_update fire from the heuristic
 * instead — explicit sources always take precedence.
 *
 * "card" action (contracts.ts's AgentAction.card, non-null only when
 * action === "card"): a visible on-page card (title, one-sentence body, one
 * CTA button) — same fixed corner as the message bubble, and like it has NO
 * auto-expiry (duration_ms is ignored for both; only used by highlight/
 * spotlight). Dismissed by ×, the CTA being taken, or a fresh message/card
 * replacing it. This embed's CTA executor (runCardCta()) only performs the
 * two kinds it can do generically on ANY host page:
 *   - open_product -> location.href = "/product/<value>"
 *   - search       -> location.href = "/search?q=<value>"
 * The other three kinds (pick_size, add_to_cart, apply_code) need the host
 * page's own cart/product logic, which this embed doesn't have — instead it
 * dispatches `window.dispatchEvent(new CustomEvent("agent:cta", { detail:
 * { kind, value } }))` and lets the host page wire up a listener. "none"
 * renders no button at all.
 *
 * Outcome tracking (server/RESEARCH.md "Outcomes" section): every non-noop
 * action carries a server-assigned `id`, echoed back as an `agent_outcome`
 * event (`outcome` ∈ cta|dismiss|turn_off|navigated|ignored) whenever the
 * shopper resolves it — ×/CTA/Turn off/navigation/replaced/tab-hidden —
 * exactly once per id. See reportOutcomeOnce() below (mirrors
 * web/components/AgentWidget.tsx's tracker of the same name).
 */
(function () {
  "use strict";

  var EVENT_TYPES = [
    "page_view", "dwell", "scroll_depth", "rage_click",
    "cart_view", "cart_update", "search", "back_nav", "agent_outcome"
  ];
  var ACTIONS = ["highlight", "scroll_to", "message", "spotlight", "card", "noop"];
  // Outcome tracking (server/RESEARCH.md "Outcomes" section) — mirrors
  // server/contracts.js's OUTCOME_KINDS.
  var OUTCOME_KINDS = ["cta", "dismiss", "turn_off", "navigated", "ignored"];
  // Mirrors the server's SESSION_ID_RE (server/contracts.js). Declared here,
  // at the IIFE's top level with the rest of the true constants, rather than
  // as a `var X = <initialiser>` statement inside boot() — boot() is a long
  // function whose top-to-bottom statement order matters (it runs
  // synchronously top to bottom on script load), and getSessionId() (called
  // from boot()'s very first few statements, via `var session =
  // getSessionId();`) reads this regex. A `var` declared further down in the
  // SAME function body is hoisted (declared) but not yet assigned at that
  // point — `SESSION_ID_RE` would be `undefined` there, and
  // `SESSION_ID_RE.test(...)` throws. This was the actual defect behind the
  // reported "fatal init error ... Cannot read properties of undefined
  // (reading 'test')" — same category as the earlier D2 pillEl bug (a
  // hoisted-but-not-yet-initialized binding read before its assignment
  // statement runs), but the fix here is different: pillEl/panelEls are
  // genuinely mutated later by boot(), so they stay bare `var name;`
  // declarations inside boot() and callers guard on truthiness; SESSION_ID_RE
  // is a true constant with zero dependency on boot()'s runtime state, so it
  // gets hoisted out entirely — parsed and assigned once, before boot() is
  // ever invoked, removing the ordering hazard rather than just satisfying it
  // for the current call sites.
  var SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  // Every safe()-wrapped call funnels its errors through here. The old
  // "warned" boolean logged the very first error ever, then silenced ALL
  // future warnings for the rest of the page's life — including unrelated
  // errors from completely different code paths, making later real bugs
  // invisible. Instead: dedupe by message (so a hot loop hitting the same
  // error doesn't spam the console) but allow up to WARN_CAP distinct
  // messages through.
  var warnedMessages = {};
  var warnedCount = 0;
  var WARN_CAP = 20;
  function warnOnce(msg, err) {
    // Fold the underlying error's own message into the dedup key — every
    // safe()-wrapped catch calls warnOnce with the same literal msg
    // ("runtime error"), so keying on msg alone would still collapse every
    // distinct bug into a single bucket.
    var errText = "";
    try { errText = err ? String(err.message || err) : ""; } catch (e) { /* noop */ }
    var key = msg + "|" + errText;
    if (Object.prototype.hasOwnProperty.call(warnedMessages, key)) return;
    if (warnedCount >= WARN_CAP) return;
    warnedMessages[key] = true;
    warnedCount++;
    try { console.warn("[agent.js] " + msg, err || ""); } catch (e) { /* noop */ }
  }
  function safe(fn) {
    return function () {
      try { return fn.apply(this, arguments); } catch (err) { warnOnce("runtime error", err); }
    };
  }

  // ---- DOM facts extraction (pure, no closure over boot() state) ----------
  // extractFactsFrom(root, helpers) walks a DOM-like tree ({textContent,
  // children, parentElement, tagName, getAttribute} — real elements or a
  // fake tree for tests) and returns { keys, snippets }. See server/FACTS.md.

  var BN_DIGITS = "০১২৩৪৫৬৭৮৯";
  // Number pattern captures the FULL run of digit groups joined by '.' or
  // ',' (e.g. "1.950,00" or "1,950.00" or "2,000") in one match — previously
  // only one trailing fractional group was captured, so a second separator
  // group (e.g. the ",00" in "1.950,00") silently fell outside the match
  // and got parsed as if it wasn't there. See normalizeNumericString().
  var RE_CURRENCY = /(?:(৳|tk\.?|bdt|\$|€|£|₹)\s*([0-9]+(?:[.,][0-9]+)*))|(?:([0-9]+(?:[.,][0-9]+)*)\s*(৳|tk\.?|bdt|\$|€|£|₹))/i;
  // A currency amount preceded (within 12 chars) by save/off/discount is a
  // promo/markdown figure, not a real total/price/fee — e.g. "Save ৳500"
  // sitting near a product H1 must never be read as the product price.
  var RE_PROMO_EXCLUDE = /\b(save|off|discount)\b/i;
  var RE_TOTAL_LABEL = /(subtotal|order\s*total|cart\s*total|total)/i;
  var RE_BN_TOTAL = /মোট/;
  var RE_SUBTOTAL_ONLY = /subtotal/i;
  var RE_TOTAL_STRICT = /\btotal\b/i;
  var RE_CART_COUNT_PAREN = /cart\s*\(\s*([0-9০-৯]+)\s*\)/i;
  var RE_CART_COUNT_ITEMS = /\b([0-9০-৯]+)\s*items?\b/i;
  var RE_FREE = /\bfree\b/i;
  var RE_DELIVERY_WORD = /\b(deliver(y|ies)?|shipping)\b/i;
  var RE_THRESHOLD_WORD = /\b(over|above|on orders? of)\b/i;
  var RE_OUT_OF_STOCK = /\b(out of stock|sold out)\b/i;
  var RE_LOW_STOCK = /\bonly\s+([0-9০-৯]+)\s+left\b/i;
  var RE_IN_STOCK = /\bin stock\b/i;
  var RE_SIZE_TOKEN = /^(xs|s|m|l|xl|xxl|[0-9]{1,2})$/i;
  var RE_SNIPPET_VOCAB = /delivery|shipping|total|stock|size|return|refund|coupon|discount|offer/i;

  function toAsciiDigits(s) {
    return String(s).replace(/[০-৯]/g, function (c) { return String(BN_DIGITS.indexOf(c)); });
  }
  // Resolves which of '.'/',' (if any) is the decimal separator in a raw
  // digit-group string (already ascii digits, e.g. "1.950,00" or "1,950"
  // or "12.50"), then returns the numeric value. Rules (see FACTS.md):
  //  - both separators present: the LAST one in the string is decimal, the
  //    other(s) are thousands separators to strip.
  //  - only one separator type, appearing exactly once: '.' followed by
  //    EXACTLY 3 digits is a thousands separator (European style, e.g.
  //    "1.950" = 1950), not a decimal point; ',' with a single occurrence
  //    defaults to thousands (matches ৳-prefixed BDT convention, e.g.
  //    "1,950" = 1950); any other lone '.' (e.g. "12.50") is a decimal.
  //  - only one separator type, appearing more than once (e.g. "1,234,567"):
  //    always thousands grouping.
  function normalizeNumericString(raw) {
    var hasDot = raw.indexOf(".") !== -1;
    var hasComma = raw.indexOf(",") !== -1;
    if (!hasDot && !hasComma) {
      var plain = parseFloat(raw);
      return isNaN(plain) ? null : plain;
    }
    var decimalChar = null;
    if (hasDot && hasComma) {
      decimalChar = raw.lastIndexOf(".") > raw.lastIndexOf(",") ? "." : ",";
    } else {
      var sepChar = hasDot ? "." : ",";
      var occurrences = raw.split(sepChar).length - 1;
      if (occurrences === 1 && sepChar === ".") {
        var afterDot = raw.slice(raw.lastIndexOf(".") + 1);
        decimalChar = (afterDot.length === 3) ? null : ".";
      } else {
        decimalChar = null; // lone/repeated ',' or repeated '.' — thousands grouping
      }
    }
    var cleaned;
    if (decimalChar) {
      var otherChar = decimalChar === "." ? "," : ".";
      cleaned = raw.split(otherChar).join("");
      if (decimalChar === ",") cleaned = cleaned.replace(",", ".");
    } else {
      cleaned = raw.replace(/[.,]/g, "");
    }
    var n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  }
  function extractCurrency(text) {
    if (!text) return null;
    var t = toAsciiDigits(text);
    var m = t.match(RE_CURRENCY);
    if (!m) return null;
    var numStr = m[2] || m[3];
    if (!numStr) return null;
    var before = t.slice(Math.max(0, m.index - 12), m.index);
    if (RE_PROMO_EXCLUDE.test(before)) return null;
    var n = normalizeNumericString(numStr);
    if (n == null || isNaN(n)) return null;
    return Math.round(n);
  }
  function tagOf(el) { return (el && el.tagName) ? String(el.tagName).toUpperCase() : ""; }
  function childrenOf(el) { return (el && el.children) ? Array.prototype.slice.call(el.children) : []; }
  function textOf(el) { return (el && el.textContent) ? String(el.textContent) : ""; }
  function attrOf(el, name) { return (el && typeof el.getAttribute === "function") ? el.getAttribute(name) : null; }
  function hasAncestorTag(el, tags) {
    var n = el, hops = 0;
    while (n && hops < 20) {
      if (tags.indexOf(tagOf(n)) !== -1) return true;
      n = n.parentElement || null;
      hops++;
    }
    return false;
  }
  // isOwnUI(node) — true if node IS, or is a descendant of, the agent's own
  // injected UI (panel/pill/message box/style tag). Every element the agent
  // creates carries data-agx-ui (see el() below), so this is the single
  // choke point both target discovery and facts extraction use to avoid
  // scanning/targeting our own DOM — the feedback-loop bug class (D1).
  // Works against real elements (uses Element.prototype.closest when
  // available) and against the fake test trees extractFactsFrom accepts
  // ({textContent, children, parentElement, tagName, getAttribute}), which
  // don't implement closest, via a manual ancestor walk.
  function isOwnUI(node) {
    if (!node) return false;
    if (typeof node.closest === "function") {
      try { return !!node.closest("[data-agx-ui]"); } catch (err) { /* fall through */ }
    }
    var n = node, hops = 0;
    while (n && hops < 40) {
      var v = attrOf(n, "data-agx-ui");
      if (v != null) return true;
      n = n.parentElement || null;
      hops++;
    }
    return false;
  }
  function scoreOf(el) {
    if (hasAncestorTag(el, ["MAIN", "ARTICLE"])) return 0;
    if (hasAncestorTag(el, ["NAV", "FOOTER"])) return 2;
    return 1;
  }

  // Shared node/time budget for ALL full-tree walks inside one
  // extractFactsFrom() call (the leaf walk, detectSizeSelected, and
  // findFirstH1). Previously each walk had its own (or no) cap, so on a
  // large page a single facts pass could do 3x full-tree traversals with
  // no combined limit, every ~500ms on any DOM mutation. One shared
  // counter/time budget bounds the total work regardless of how many
  // sub-walks run.
  var FACTS_MAX_NODES = 5000;
  var FACTS_TIME_BUDGET_MS = 5;
  function overBudget(budget) {
    if (budget.partial) return true;
    budget.visited++;
    if (budget.visited > FACTS_MAX_NODES) { budget.partial = true; return true; }
    if (budget.visited % 200 === 0 && (Date.now() - budget.start) > FACTS_TIME_BUDGET_MS) {
      budget.partial = true;
      return true;
    }
    return false;
  }

  function detectSizeSelected(root, budget) {
    var groups = []; // [{parent, kids: []}]
    function findGroup(parent) {
      for (var i = 0; i < groups.length; i++) if (groups[i].parent === parent) return groups[i];
      var g = { parent: parent, kids: [] };
      groups.push(g);
      return g;
    }
    function visit(node, depth) {
      if (!node || depth > 60 || overBudget(budget)) return;
      var tag = tagOf(node);
      if (tag === "BUTTON" || tag === "LABEL") {
        var txt = textOf(node).trim();
        if (txt && txt.length <= 4 && RE_SIZE_TOKEN.test(txt) && node.parentElement) {
          findGroup(node.parentElement).kids.push(node);
        }
      }
      var kids = childrenOf(node);
      for (var i = 0; i < kids.length; i++) visit(kids[i], depth + 1);
    }
    try { visit(root, 0); } catch (err) { /* bail with whatever was found */ }
    var found = false, anySelected = false;
    groups.forEach(function (g) {
      if (g.kids.length < 3) return;
      found = true;
      var sel = g.kids.some(function (n) {
        if (attrOf(n, "aria-pressed") === "true" || attrOf(n, "aria-checked") === "true") return true;
        var cls = attrOf(n, "class") || "";
        if (cls.indexOf("selected") !== -1 || cls.indexOf("active") !== -1) return true;
        return childrenOf(n).some(function (c) {
          if (tagOf(c) !== "INPUT") return false;
          if (c.checked === true) return true;
          // HTML boolean attributes (e.g. <input checked>) read back as ""
          // via getAttribute — presence (non-null, not explicitly "false")
          // means checked, not string equality to "true"/"checked".
          var checkedAttr = attrOf(c, "checked");
          return checkedAttr !== null && checkedAttr !== "false";
        });
      });
      if (sel) anySelected = true;
    });
    if (!found) return "unknown";
    return anySelected ? "true" : "false";
  }

  function extractFactsFrom(root, helpers) {
    var isHidden = (helpers && helpers.isHidden) || function () { return false; };
    // One budget, shared across the leaf walk below AND detectSizeSelected/
    // findFirstH1 further down — see overBudget() / FACTS_MAX_NODES.
    var budget = { visited: 0, start: Date.now(), partial: false };
    var leaves = [];

    function walk(node) {
      if (!node || overBudget(budget)) return;
      var tag = tagOf(node);
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return;
      if (isHidden(node)) return;
      if (isOwnUI(node)) return; // never scan the agent's own injected UI (D1)
      var kids = childrenOf(node);
      if (kids.length === 0) {
        var t = textOf(node).trim();
        if (t) leaves.push(node);
        return;
      }
      for (var i = 0; i < kids.length && !budget.partial; i++) walk(kids[i]);
    }
    try { walk(root); } catch (err) { /* bail with partial results */ }

    var totalCandidates = [], thresholdCandidates = [], feeCandidates = [];
    var cartCountVal = null, stockVal = null, priceVal = null;
    var h1Found = null;

    leaves.forEach(function (leaf, idx) {
      var t = textOf(leaf).trim();
      if (!t || t.length > 200) return;

      if (RE_TOTAL_LABEL.test(t) || RE_BN_TOTAL.test(t)) {
        var val = extractCurrency(t);
        if (val == null && leaf.parentElement) val = extractCurrency(textOf(leaf.parentElement));
        if (val == null && leaf.parentElement && leaf.parentElement.parentElement) {
          val = extractCurrency(textOf(leaf.parentElement.parentElement));
        }
        if (val != null) {
          var isSubtotalOnly = RE_SUBTOTAL_ONLY.test(t) && !RE_TOTAL_STRICT.test(t.replace(RE_SUBTOTAL_ONLY, ""));
          totalCandidates.push({ value: val, score: scoreOf(leaf), priority: isSubtotalOnly ? 1 : 0, idx: idx });
        }
      }

      if (RE_FREE.test(t) && RE_DELIVERY_WORD.test(t) && RE_THRESHOLD_WORD.test(t)) {
        var tv = extractCurrency(t);
        if (tv == null && leaf.parentElement) tv = extractCurrency(textOf(leaf.parentElement));
        if (tv != null) thresholdCandidates.push({ value: tv, score: scoreOf(leaf), idx: idx });
      } else if (RE_DELIVERY_WORD.test(t) && !RE_FREE.test(t)) {
        var fv = extractCurrency(t);
        if (fv != null) feeCandidates.push({ value: fv, score: scoreOf(leaf), idx: idx });
      }

      if (cartCountVal == null) {
        var mParen = t.match(RE_CART_COUNT_PAREN) || t.match(RE_CART_COUNT_ITEMS);
        if (mParen) {
          var n = parseInt(toAsciiDigits(mParen[1]), 10);
          if (!isNaN(n)) cartCountVal = n;
        }
      }

      if (!stockVal) {
        if (RE_OUT_OF_STOCK.test(t)) stockVal = "out_of_stock";
        else {
          var mLow = t.match(RE_LOW_STOCK);
          if (mLow) stockVal = "low_stock:" + toAsciiDigits(mLow[1]);
          else if (RE_IN_STOCK.test(t)) stockVal = "in_stock";
        }
      }
    });

    function pickBest(list) {
      if (!list.length) return null;
      list.sort(function (a, b) {
        if ((a.priority || 0) !== (b.priority || 0)) return (a.priority || 0) - (b.priority || 0);
        if (a.score !== b.score) return a.score - b.score;
        return a.idx - b.idx;
      });
      return list[0];
    }
    var bestTotal = pickBest(totalCandidates);
    var bestThreshold = pickBest(thresholdCandidates);
    var bestFee = pickBest(feeCandidates);

    // price: largest currency number near the first h1 (best-effort — no
    // font-size signal available without a live browser; see FACTS.md).
    function findFirstH1(node, depth) {
      if (!node || depth > 60 || overBudget(budget)) return null;
      if (tagOf(node) === "H1") return node;
      var kids = childrenOf(node);
      for (var i = 0; i < kids.length; i++) {
        var found = findFirstH1(kids[i], depth + 1);
        if (found) return found;
      }
      return null;
    }
    try { h1Found = findFirstH1(root, 0); } catch (err) { h1Found = null; }
    if (h1Found) {
      var scope = h1Found.parentElement && h1Found.parentElement.parentElement
        ? h1Found.parentElement.parentElement : (h1Found.parentElement || null);
      if (scope) {
        leaves.forEach(function (leaf) {
          var n = leaf, within = false, hops = 0;
          while (n && hops < 10) { if (n === scope) { within = true; break; } n = n.parentElement; hops++; }
          if (!within) return;
          var t = textOf(leaf).trim();
          if (t.length > 30) return;
          var pv = extractCurrency(t);
          if (pv != null && (priceVal == null || pv > priceVal)) priceVal = pv;
        });
      }
    }

    var keys = {};
    if (bestTotal) keys.cart_total = bestTotal.value;
    if (cartCountVal != null) keys.cart_count = cartCountVal;
    if (bestThreshold) keys.free_delivery_threshold = bestThreshold.value;
    if (bestFee) keys.delivery_fee = bestFee.value;
    if (stockVal) keys.stock = stockVal;
    var sizeSel = detectSizeSelected(root, budget);
    if (sizeSel !== "unknown") keys.size_selected = sizeSel;
    if (priceVal != null) keys.price = priceVal;

    var snippetCandidates = [];
    var seenNorm = {};
    leaves.forEach(function (leaf, idx) {
      if (hasAncestorTag(leaf, ["NAV", "FOOTER"])) return;
      var t = textOf(leaf).trim();
      if (!t || !RE_SNIPPET_VOCAB.test(t)) return;
      var snippet = t.length > 120 ? t.slice(0, 120) : t;
      var norm = snippet.toLowerCase();
      if (seenNorm[norm]) return;
      seenNorm[norm] = true;
      snippetCandidates.push({
        text: snippet,
        score: hasAncestorTag(leaf, ["MAIN", "ARTICLE"]) ? 0 : 1,
        len: snippet.length,
        idx: idx
      });
    });
    snippetCandidates.sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;
      if (a.len !== b.len) return a.len - b.len;
      return a.idx - b.idx;
    });
    var snippets = snippetCandidates.slice(0, 10).map(function (c) { return c.text; });

    return { keys: keys, snippets: snippets };
  }

  // ---- persistent assistant panel (launcher + tray) helpers ---------------
  // Suggestions tray persistence — sessionStorage can throw (Safari private
  // mode, storage disabled, embed inside a locked-down iframe host page),
  // same as every other storage access in this file; degrade to an
  // in-memory list for the tab's lifetime rather than throwing.
  var SUGGESTIONS_KEY = "agent_embed_suggestions";
  // unread-badge-resets-on-remount defect class (mirrors web/components/
  // AgentWidget.tsx): this widget is a plain <script> tag, so every full
  // page nav on a non-SPA host page re-runs this whole file from scratch —
  // `suggestions` restores in full from sessionStorage, but a badge counter
  // seeded to 0 on every (re)init would undercount relative to how many of
  // those restored suggestions the shopper never actually saw. Persist a
  // "seen before this timestamp" marker alongside the list and derive the
  // initial unseen count from it instead of assuming 0.
  var SUGGESTIONS_SEEN_AT_KEY = "agent_embed_suggestions_seen_at";
  var MAX_SUGGESTIONS = 200;
  var SHOW_ME_PULSE_MS = 5000;
  var memorySuggestions = null;
  var memorySeenAt = 0;
  function loadSuggestions() {
    try {
      var raw = sessionStorage.getItem(SUGGESTIONS_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Object.prototype.toString.call(parsed) === "[object Array]" ? parsed : [];
    } catch (err) {
      return memorySuggestions || [];
    }
  }
  function saveSuggestions(list) {
    try {
      sessionStorage.setItem(SUGGESTIONS_KEY, JSON.stringify(list));
    } catch (err) {
      memorySuggestions = list;
    }
  }
  function loadSeenAt() {
    try {
      var raw = sessionStorage.getItem(SUGGESTIONS_SEEN_AT_KEY);
      var n = raw ? Number(raw) : 0;
      return isFinite(n) ? n : 0;
    } catch (err) {
      return memorySeenAt;
    }
  }
  function saveSeenAt(ts) {
    try {
      sessionStorage.setItem(SUGGESTIONS_SEEN_AT_KEY, String(ts));
    } catch (err) {
      memorySeenAt = ts;
    }
  }
  // Tray/badge-desync defect class: a resolved suggestion (its live card/
  // message/highlight already ended — see markSuggestionResolved) never
  // counts as unseen regardless of timestamp, same rule as
  // web/components/AgentWidget.tsx's countUnseen.
  function countUnseen(list, seenAt) {
    var n = 0;
    for (var i = 0; i < list.length; i++) if (list[i].ts > seenAt && !list[i].resolved) n++;
    return n;
  }
  // Developer-text-leaks-to-shopper defect class: `data-agent-target`
  // values (`product-card-nakshi-kantha-scarf`, `size-guide`, ...) and raw
  // event/trace strings (`dwell /product/khadi-field-jacket 125s`, `quiet
  // tick: dwell within same bucket, no new signal`) are internal
  // identifiers/debug text, never shopper copy. Every shopper-facing
  // surface (suggestion tray, "What I noticed") goes through the small
  // formatters below instead of interpolating the raw string. The separate
  // dev trace panel is unaffected — that one is explicitly for developers.
  // Mirrored in web/components/AgentWidget.tsx.
  var TARGET_LABELS = {
    "size-guide": "the size guide",
    "size-picker": "the size picker",
    "size-chart": "the size chart",
    "cart-add": "the add-to-cart button",
    "shipping-banner": "the shipping banner",
    "product-image": "the product photo",
    "search": "the search box",
    "similar-products": "the similar products",
    "cart-items": "your cart items",
    "cart-link": "your cart",
    "cart-total": "your cart total",
    "checkout-btn": "checkout",
    "checkout-total": "the checkout total",
    "address-form": "the address form",
    "payment-options": "payment options",
    "place-order": "place order",
    "promo-code": "the promo code field"
  };
  function titleCaseSlug(slug) {
    return String(slug).split(/[-_]+/).filter(Boolean).map(function (w) {
      return w[0].toUpperCase() + w.slice(1);
    }).join(" ");
  }
  // Raw-path-title-cased-as-a-label defect class: title-casing a whole path
  // ("/products/chaa-break-mug" -> "Products/chaa Break Mug") leaks the
  // route prefix into shopper-facing copy. lastPathSegment() + the product
  // regex below always slug from the LAST segment only, never the full
  // path, so no route prefix can ever survive into a label.
  function lastPathSegment(path) {
    var segs = String(path).split("/").filter(Boolean);
    return segs.length ? segs[segs.length - 1] : "";
  }
  // Per-path cache of a DOM-derived page label (see capturePageLabel),
  // populated every sendPageView — including for paths the shopper has
  // since navigated away from, so a later "You spent 1 min on <path>" line
  // (built from an OLD trace signal, current DOM no longer matches) still
  // resolves to the real product/page name instead of a slug guess.
  // Mirrored in web/components/AgentWidget.tsx.
  var pageLabelCache = {};
  // Splits a <title> on the first " | " or " – " (en dash) separator —
  // common "Product Name | Store" / "Product Name – Store" conventions —
  // and returns the part before it. Plain hyphens inside the title itself
  // (e.g. "T-Shirt") are left alone since the separator must be
  // surrounded by spaces.
  function titleBeforeSeparator(title) {
    if (!title) return null;
    var parts = String(title).split(/\s\|\s|\s–\s/);
    var first = parts[0] ? parts[0].trim() : "";
    return first || null;
  }
  // Label resolution order (both widgets): (a) an explicit product/page
  // name read off the page itself — [data-agent-target="product-title"],
  // else the first <h1>, else document.title before the first separator;
  // (b) known route words for paths with no on-page name to read; (c) the
  // last path segment, slugified, as a last resort (never the raw path).
  function resolveDomPageLabel() {
    var el = null;
    try { el = document.querySelector('[data-agent-target="product-title"]'); } catch (err) { el = null; }
    var text = el && el.textContent ? el.textContent.trim() : "";
    if (!text) {
      try { el = document.querySelector("h1"); } catch (err) { el = null; }
      text = el && el.textContent ? el.textContent.trim() : "";
    }
    if (!text) text = titleBeforeSeparator(document.title) || "";
    return text || null;
  }
  // Captures the current page's DOM-derived label into pageLabelCache,
  // keyed by path. Called from sendPageView() (boot, every SPA navigation,
  // every rate-limited resend) so the cache is populated while the page's
  // own DOM is still live and queryable.
  function capturePageLabel(path) {
    if (!path) return;
    var label = resolveDomPageLabel();
    if (label) pageLabelCache[path] = label;
  }
  function humanTargetLabel(target) {
    if (!target) return "something on the page";
    if (Object.prototype.hasOwnProperty.call(TARGET_LABELS, target)) return TARGET_LABELS[target];
    var m = String(target).match(/^product-card-(.+)$/) || String(target).match(/^similar-(.+)$/) || String(target).match(/^\/products?\/(.+)$/);
    if (m) return titleCaseSlug(lastPathSegment(m[1]));
    return titleCaseSlug(target);
  }
  function humanPageLabel(path) {
    if (Object.prototype.hasOwnProperty.call(pageLabelCache, path)) return pageLabelCache[path];
    if (path === "/") return "the homepage";
    if (path === "/cart") return "your cart";
    if (path === "/checkout") return "checkout";
    if (/^\/search(\/|\?|$)/.test(path)) return "the search page";
    if (path === "/shop") return "the shop";
    var m = String(path).match(/^\/products?\/(.+)$/);
    if (m) return titleCaseSlug(lastPathSegment(m[1]));
    var seg = lastPathSegment(path);
    return (seg && titleCaseSlug(seg)) || "the page";
  }
  /** Plain-language sentence for a delivered action — used by the
   * suggestions tray for every action kind (a `message` action's own text
   * is shown verbatim instead, see addSuggestion; it's already
   * shopper-authored copy from the decider). `card` actions are described
   * by their CTA rather than the card's own body text, so the tray line
   * matches the mapping table (action type + target/CTA label -> human
   * phrase). */
  function suggestionSentence(a) {
    // Same path-vs-target-id branch as parseNoticedSignal below: a.target
    // can be a page path ("/products/chaa-break-mug") rather than a
    // data-agent-target id, and paths resolve through humanPageLabel (DOM/
    // cache-aware) instead of humanTargetLabel.
    var label = a.target && a.target.charAt(0) === "/" ? humanPageLabel(a.target) : humanTargetLabel(a.target);
    if (a.action === "card" && a.card) {
      var cta = a.card.cta || {};
      switch (cta.kind) {
        case "pick_size":
          return cta.value ? "Suggested size " + cta.value : "Suggested picking a size";
        case "add_to_cart":
          return cta.value ? "Suggested adding " + titleCaseSlug(cta.value) + " to your cart" : "Suggested adding an item to your cart";
        case "apply_code":
          return cta.value ? "Offered code " + cta.value : "Offered a discount code";
        case "open_product":
          return cta.value ? "Pointed you to " + titleCaseSlug(cta.value) : "Pointed you to a similar product";
        case "search":
          return cta.value ? 'Suggested searching for "' + cta.value + '"' : "Suggested a search";
        case "none":
        default:
          return a.card.title || "Shared a suggestion";
      }
    }
    if (a.action === "highlight") return "Highlighted " + label + " for you";
    if (a.action === "spotlight") return "Spotlighted " + label + " for you";
    if (a.action === "scroll_to") return "Scrolled you to " + label;
    return "Drew attention to " + label;
  }
  // Developer-text-leaks-to-shopper defect class, continued: index.js's own
  // quiet-tick/gate/backpressure short-circuit (never reaches a decider)
  // writes internal plumbing straight into trace.why — "quiet tick: dwell
  // within same bucket, no new signal", "gated: <reason>", "overloaded" —
  // as opposed to a REAL noop decision's why, which is decider-authored
  // human text. Only the shopper-facing "What I noticed" panel needs this
  // filter; the dev trace panel shows the raw trace either way.
  var INTERNAL_WHY_PATTERN = /^(quiet tick|gated:|overloaded)/i;
  function shopperSafeWhy(why) {
    if (!why) return null;
    return INTERNAL_WHY_PATTERN.test(why) ? null : why;
  }
  function formatNoticedDuration(seconds) {
    if (seconds < 60) return seconds + "s";
    return Math.round(seconds / 60) + " min";
  }
  /** Parses ONE raw trace.signals[] string (server/state.js's summarize())
   * into a dedup key + a human sentence. Unknown/unrecognized shapes return
   * null — the caller omits them rather than falling back to the raw
   * string. Mirrors web/components/AgentWidget.tsx. */
  function parseNoticedSignal(sig) {
    var m = sig.match(/^(?:dwell|attention) (\S+) (\d+)s/);
    if (m) {
      var target = m[1];
      var label = target.charAt(0) === "/" ? humanPageLabel(target) : humanTargetLabel(target);
      return { key: "dwell:" + target, text: "You spent " + formatNoticedDuration(Number(m[2])) + " on " + label };
    }
    if ((m = sig.match(/^page_view\s*(\S*)/))) {
      var path = m[1] || "/";
      return { key: "page_view:" + path, text: "You viewed " + humanPageLabel(path) };
    }
    if (sig.indexOf("cart_view") === 0) return { key: "cart_view", text: "You opened your cart" };
    if (sig.indexOf("cart_update") === 0) return { key: "cart_update", text: "You updated your cart" };
    if (sig.indexOf("search") === 0) return { key: "search", text: "You searched the store" };
    if ((m = sig.match(/^rage_click\s*(\S*)/))) {
      var rtarget = m[1];
      return {
        key: "rage_click:" + (rtarget || ""),
        text: "You clicked " + (rtarget ? humanTargetLabel(rtarget) : "something on the page") + " repeatedly"
      };
    }
    if (sig.indexOf("scroll_depth") === 0) return { key: "scroll_depth", text: "You scrolled through the page" };
    if (sig.indexOf("back_nav") === 0) return { key: "back_nav", text: "You went back a page" };
    return null;
  }
  /** "What I noticed" signal lines: dedupe by (page/target, kind) — keeping
   * the LATEST value and moving it to the most-recent position — then cap
   * at 4. Mirrors web/components/AgentWidget.tsx. */
  function buildNoticedLines(signals) {
    var texts = {};
    var order = [];
    for (var i = 0; i < (signals || []).length; i++) {
      var parsed = parseNoticedSignal(signals[i]);
      if (!parsed) continue;
      texts[parsed.key] = parsed.text;
      var idx = order.indexOf(parsed.key);
      if (idx !== -1) order.splice(idx, 1);
      order.push(parsed.key);
    }
    return order.slice(-4).map(function (k) { return texts[k]; });
  }
  // Allow-list CTA executor for the "card" action — see the file header
  // comment for what each kind does and why only two of the five are
  // performed directly here. Shared by the live on-page card's button and a
  // tray suggestion's replay of an old card. Anything outside CardCtaKind
  // (contracts.ts) or with no value is a no-op.
  function runCardCta(cta) {
    if (!cta) return;
    switch (cta.kind) {
      case "open_product":
        if (cta.value) location.href = "/product/" + encodeURIComponent(cta.value);
        return;
      case "search":
        if (cta.value) location.href = "/search?q=" + encodeURIComponent(cta.value);
        return;
      case "pick_size":
      case "add_to_cart":
      case "apply_code":
        try {
          window.dispatchEvent(new CustomEvent("agent:cta", { detail: { kind: cta.kind, value: cta.value || null } }));
        } catch (err) { /* CustomEvent unsupported — no-op */ }
        return;
      case "none":
      default:
        return;
    }
  }
  function timeAgo(ts, now) {
    var s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60) return s + "s ago";
    var m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.round(m / 60);
    return h + "h ago";
  }
  // "What I noticed" — ONE coherent primary line (mirrors web/components/
  // AgentWidget.tsx's noticedPrimaryText): what it did + why if it acted, or
  // just the quiet reason if it didn't — never a hypothesis-shaped sentence
  // immediately followed by a contradicting "nothing to help with" line.
  function noticedPrimaryText(t) {
    if (!t) return "Watching. Nothing decided yet.";
    if (t.decision === "noop") return "Nothing to help with right now: browsing normally."; // model reasoning and errors never reach the shopper
    return t.why ? "Decided to " + t.decision + " — " + t.why : "Decided to " + t.decision + ".";
  }

  function startBoot() {
    try { boot(); } catch (err) { warnOnce("fatal init error", err); }
  }
  // boot() reads/appends to document.body (pill/panel/message box) and
  // queries the DOM for targets. If this <script> runs without `defer`
  // from inside <head>, document.body is still null at this point and
  // every document.body.appendChild() throws (silently, via warnOnce's
  // dedup — see D1/M12) with nothing ever actually mounting. Defer to
  // DOMContentLoaded in that case instead of assuming defer/end-of-body
  // placement.
  if (typeof document !== "undefined" && !document.body) {
    document.addEventListener("DOMContentLoaded", startBoot);
  } else {
    startBoot();
  }

  // Exposed unconditionally (even if boot() failed / no real DOM present) so
  // a standalone probe can call the pure extractor without a browser.
  try {
    if (typeof window !== "undefined") {
      if (!window.AgentEmbed) window.AgentEmbed = {};
      window.AgentEmbed._extract = extractFactsFrom;
    }
  } catch (err) { /* noop — non-browser eval context */ }

  function boot() {
    var scriptEl = document.currentScript ||
      (function () { var s = document.getElementsByTagName("script"); return s[s.length - 1]; })();

    var cfg = {
      server: (scriptEl && scriptEl.getAttribute("data-server")) || location.origin,
      panel: scriptEl && scriptEl.getAttribute("data-panel") === "true",
      site: (scriptEl && scriptEl.getAttribute("data-site")) || "",
      targetsMode: (scriptEl && scriptEl.getAttribute("data-targets")) || "auto",
      factsMode: (function () {
        var v = scriptEl && scriptEl.getAttribute("data-facts");
        return (v === "keys" || v === "snippets" || v === "both" || v === "off") ? v : "both";
      })()
    };
    cfg.httpBase = cfg.server.replace(/\/+$/, "");
    cfg.wsBase = cfg.httpBase.replace(/^http/i, "ws");

    var session = getSessionId();
    var DWELL_TICK_MS = 5000;
    var pageStart = Date.now();
    var pagePath = location.pathname;

    var state = {
      targets: [],
      targetsKey: "",
      elDwell: new Map(),      // el -> { visibleSince }
      clickBursts: new WeakMap(),  // el -> [timestamps]; WeakMap — no iteration needed, avoids pinning detached elements
      scrollSeen: new Set(),
      activeHighlights: [],    // [{el, cls, timer}]
      spotlightEl: null,
      spotlightTimer: null,
      spotlightActionId: null, // outcome tracking — see clearActiveExecution()
      spotlightShownAt: 0,
      lastEffectAt: 0,         // Date.now() a highlight/spotlight last started — the click-grace window (see EFFECT_GRACE_MS) reads this
      messageTimer: null,
      traces: [],
      lastNoopStreak: 0,
      metrics: null,
      ws: null,
      wsBackoff: 1000,
      wsClosed: false,
      enabled: getEnabled(),
      facts: null,
      // In-page demo player (DEMO.md "No-terminal demo"): fixtures come from
      // GET /demo/fixtures (only exists when the server has AGENT_DEBUG=1 —
      // 404/network error elsewhere, panel stays clean). demoStatus tracks
      // the one fixture this tab is currently playing/just finished/errored
      // on; demoLine is the subtle status line fed by incoming
      // {kind:"demo"} WS messages.
      demoFixtures: [],
      demoStatus: null,
      demoLine: null,
      // Persistent assistant panel (launcher + tray) — see buildAssistPanel().
      // suggestions: every non-noop action ever delivered this session,
      // newest first, persisted to sessionStorage so a reload doesn't lose
      // the tray. unseenCount resets to 0 whenever the panel is opened.
      suggestions: loadSuggestions(),
      unseenCount: countUnseen(loadSuggestions(), loadSeenAt()),
      noticedWhyOpen: false,
      assistOpen: false,
      // Tester tools (brief: rendered only when the server has AGENT_DEBUG) —
      // true once EITHER GET /demo/fixtures returns a non-empty list OR a
      // probe to GET /sessions?limit=1 returns 200 (the former alone
      // under-detects AGENT_DEBUG outside AGENT_MODE=cached).
      debugAvailable: false,
      decideBusy: false,
      resetBusy: false,
      // Deciding-indicator: a decision (live LLM) takes 15-20s, and quiet
      // ticks get collapsed into one row, so the panel can look frozen for
      // that whole window with nothing telling the shopper/operator the
      // server is still working. lastTraceAt is bumped on every {kind:
      // "trace"} frame; the interval below shows "thinking · Ns" once it's
      // been >3s since the last one and the socket is open, and clears on
      // the next trace.
      lastTraceAt: Date.now()
    };

    // ---- outcome tracking (server/RESEARCH.md "Outcomes" section) --------
    // Mirrors web/components/AgentWidget.tsx's reportOutcomeOnce/
    // pendingActionInfo — see that file's comments for the full rationale.
    // reportedOutcomeIds: exactly ONE outcome per action id (client-side
    // half; live-record.js's recordOutcome() dedups again server-side).
    var reportedOutcomeIds = {};
    // pendingActionInfo: action id -> { action, target, ctaKind }, populated
    // once in addSuggestion() (called for every non-noop action regardless
    // of state.enabled — see applyAction()).
    var pendingActionInfo = {};
    function reportOutcomeOnce(actionId, outcome, shownAt) {
      if (!actionId || reportedOutcomeIds[actionId]) return;
      reportedOutcomeIds[actionId] = true;
      var info = pendingActionInfo[actionId] || {};
      var meta = {
        action_id: actionId,
        action: info.action || "unknown",
        outcome: outcome,
        ms_visible: Math.max(0, Date.now() - (shownAt || Date.now()))
      };
      if (info.ctaKind) meta.cta_kind = info.ctaKind;
      emit("agent_outcome", info.target || null, meta);
    }

    injectStyles();
    var ui = cfg.panel ? buildPanel() : null;
    // The old standalone on/off pill is retired — its control now lives
    // inside the assistant panel's Controls section (agx-toggle-btn, see
    // buildAssistPanel() below) so it doesn't visually collide with the new
    // persistent launcher in the same bottom-right corner.

    function emit(type, target, meta) {
      if (EVENT_TYPES.indexOf(type) === -1) return;
      var body = { session: session, type: type, target: target || null, ts: Date.now(), meta: meta || undefined };
      try {
        fetch(cfg.httpBase + "/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          keepalive: true
        }).catch(function () {});
      } catch (err) { /* swallow — never throw into host page */ }
    }
    // ----
    function slugify(text) {
      return (text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
    }
    function domPathHash(el) {
      var path = [], node = el, depth = 0;
      while (node && node.nodeType === 1 && depth < 8) {
        var idx = 0, sib = node;
        while ((sib = sib.previousElementSibling)) idx++;
        path.push(node.tagName + idx);
        node = node.parentElement;
        depth++;
      }
      var str = path.join(">");
      var h = 0;
      for (var i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; }
      return Math.abs(h).toString(36).slice(0, 6);
    }
    function visibleArea(el) {
      var r = el.getBoundingClientRect();
      return Math.max(0, r.width) * Math.max(0, r.height);
    }
    function isVisibleEl(el) {
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      var style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    }
    function isCoarsePointer() {
      return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    }
    function assignId(el, used) {
      var id = el.id ? el.id : (el.getAttribute("data-testid") ? el.getAttribute("data-testid") : null);
      if (!id) {
        var text = (el.textContent || "").trim();
        var base = slugify(text) || slugify(el.tagName);
        id = (base || "el") + "-" + domPathHash(el);
      }
      var candidate = id, n = 1;
      while (used.has(candidate)) { candidate = id + "-" + (n++); }
      used.add(candidate);
      return candidate;
    }

    // Decided ONCE, on the first call, before we've ever auto-assigned any
    // data-agent-target attribute ourselves. Without this, the very first
    // auto-scan tags a batch of elements, then every later rescan sees
    // explicit.length > 0 and permanently switches to the "manual" branch
    // (querying only already-tagged elements) — new elements added later
    // (modals, SPA re-renders, infinite-scroll pages) are never discovered
    // again. "auto" mode always re-runs the full heuristic selector so new
    // elements keep getting picked up on every rescan.
    var targetMode = null; // "manual" | "auto"
    function discoverTargets() {
      if (targetMode === null) {
        var preExisting = document.querySelectorAll("[data-agent-target]").length > 0;
        targetMode = (preExisting || cfg.targetsMode === "manual") ? "manual" : "auto";
      }
      var candidates;
      if (targetMode === "manual") {
        candidates = Array.prototype.slice.call(document.querySelectorAll("[data-agent-target]"));
      } else {
        var sel = "button, a[href], input, select, textarea, h1, h2, [role='button'], [id]";
        var found = Array.prototype.slice.call(document.querySelectorAll(sel));
        candidates = found.filter(function (el) {
          if (!isVisibleEl(el)) return false;
          if (el.tagName === "A" && !(el.textContent || "").trim()) return false;
          return true;
        });
      }
      // never target the agent's own injected UI (D1) — applies to both the
      // explicit [data-agent-target] branch and the heuristic scan branch.
      candidates = candidates.filter(function (el) { return !isOwnUI(el); });
      // dedupe elements
      var seen = new Set();
      candidates = candidates.filter(function (el) {
        if (seen.has(el)) return false;
        seen.add(el);
        return true;
      });
      // cap at 40 by visible area, largest first
      candidates.sort(function (a, b) { return visibleArea(b) - visibleArea(a); });
      candidates = candidates.slice(0, 40);

      var used = new Set();
      var ids = [];
      candidates.forEach(function (el) {
        var id = el.getAttribute("data-agent-target");
        if (!id) {
          id = assignId(el, used);
          el.setAttribute("data-agent-target", id);
        } else {
          used.add(id);
        }
        ids.push(id);
      });
      ids.sort();
      var key = ids.join(",");
      var changed = key !== state.targetsKey;
      state.targets = ids;
      state.targetsKey = key;
      return changed;
    }

    function targetEl(id) {
      if (!id) return null;
      try { return document.querySelector('[data-agent-target="' + cssEscape(id) + '"]'); }
      catch (err) { return null; }
    }
    function cssEscape(s) {
      return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) {
        return "\\" + c;
      });
    }

    function sendPageView() {
      capturePageLabel(pagePath);
      var meta = { targets: state.targets.slice(), site: cfg.site, title: document.title };
      if (state.facts && cfg.factsMode !== "off") meta.facts = state.facts;
      emit("page_view", pagePath, meta);
      checkRouteSearch();
    }

    // ---- rate-limited page_view resend (D1 feedback-loop guard) ----------
    // Facts/target rescans can legitimately want to resend page_view when
    // the page's discoverable state changes, but nothing should ever be
    // able to hammer /event: at most one auto resend per 2s, and never a
    // resend when the serialized targets+facts key hasn't actually moved.
    var PAGE_VIEW_RATE_MS = 5000;
    var lastAutoPageViewKey = null;
    var lastAutoPageViewTs = 0;
    function sendPageViewIfChanged() {
      var key = state.targetsKey + "|" + (lastFactsJson || "");
      if (key === lastAutoPageViewKey) return;
      var now = Date.now();
      if (lastAutoPageViewKey !== null && (now - lastAutoPageViewTs) < PAGE_VIEW_RATE_MS) return;
      lastAutoPageViewKey = key;
      lastAutoPageViewTs = now;
      sendPageView();
    }
    function resetPageViewRateLimit() {
      lastAutoPageViewKey = null;
      lastAutoPageViewTs = 0;
    }

    // ---- facts extraction runtime wiring ----
    var lastFactsJson = null;
    var factsCartSnapshot = null;
    function isHiddenForFacts(el) {
      try {
        if (!el || el.nodeType !== 1) return false;
        if (el.hasAttribute && el.hasAttribute("hidden")) return true;
        if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return true;
        var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
        return !!style && (style.visibility === "hidden" || style.display === "none");
      } catch (err) { return false; }
    }
    function maybeEmitFactsCart(facts) {
      if (!facts || !facts.keys || facts.keys.cart_total == null) return;
      if (readCart()) return; // explicit source present — heuristic disabled
      var total = facts.keys.cart_total;
      var key = String(total);
      if (factsCartSnapshot === null) {
        factsCartSnapshot = key;
        emit("cart_view", null, { total: total, items: [] });
        return;
      }
      if (key !== factsCartSnapshot) {
        factsCartSnapshot = key;
        emit("cart_update", null, { total: total, items: [] });
      }
    }
    function computeAndMaybeEmitFacts() {
      if (cfg.factsMode === "off") { state.facts = null; return; }
      var raw = extractFactsFrom(document.body || document.documentElement, { isHidden: isHiddenForFacts });
      var out = {};
      if (cfg.factsMode === "keys" || cfg.factsMode === "both") out.keys = raw.keys;
      if (cfg.factsMode === "snippets" || cfg.factsMode === "both") out.snippets = raw.snippets;
      var json = JSON.stringify(out);
      if (json === lastFactsJson) return;
      lastFactsJson = json;
      state.facts = out;
      sendPageViewIfChanged();
      maybeEmitFactsCart(out);
    }
    function scheduleFactsRun() {
      var run = safe(computeAndMaybeEmitFacts);
      if (window.requestIdleCallback) window.requestIdleCallback(run);
      else setTimeout(run, 0);
    }

    discoverTargets();
    sendPageView();
    scheduleFactsRun();

    // Re-scan on DOM mutation (debounced) and on route change.
    var rescanTimer = null;
    function scheduleRescan() {
      if (rescanTimer) clearTimeout(rescanTimer);
      rescanTimer = setTimeout(safe(function () {
        var changed = discoverTargets();
        if (changed) sendPageViewIfChanged();
      }), 500);
    }
    var factsRescanTimer = null;
    function scheduleFactsRescan() {
      if (factsRescanTimer) clearTimeout(factsRescanTimer);
      factsRescanTimer = setTimeout(safe(computeAndMaybeEmitFacts), 500);
    }
    var mo = new MutationObserver(safe(function (records) {
      // Ignore mutations entirely inside the agent's own injected UI (D1) —
      // e.g. the panel's live metrics/trace text, which otherwise churns
      // every tick and would perpetually re-trigger rescans.
      var relevant = records.some(function (r) { return !isOwnUI(r.target); });
      if (!relevant) return;
      scheduleRescan();
      scheduleFactsRescan();
    }));
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: false });

    function onRouteChange() {
      pagePath = location.pathname;
      pageStart = Date.now();
      // Route change = a hard per-page boundary for every per-element
      // tracker below (per-element-state-leak-across-navigations defect
      // class — see web/components/AgentWidget.tsx's matching reset for the
      // Next.js client, and server/state.js/index.js for the server-side
      // half). None of these may attribute anything to the page the shopper
      // just left, even when the same target id also exists on the new
      // page:
      //   - elAttn (per-element ATTENTION state — hover/focus/click/
      //     scroll-into-view, see the per-element-dwell-is-viewport-time
      //     defect-class comment near elAttn's declaration below): disconnect
      //     the observer (drops any pending intersection records for
      //     now-stale elements) and wipe the map. discoverTargets() below
      //     re-observes whatever still exists via the wrapped override (see
      //     `discoverTargets = function () { ... }`).
      //   - hoveredTarget: the hovered element (if any) belonged to the page
      //     just left.
      //   - state.scrollSeen (25/50/75/100 thresholds already emitted):
      //     scroll_depth is "once per page", not "once per session" — a
      //     shopper who scrolled 100% on the last page must still get a
      //     fresh 25% event on this one.
      //   - any active highlight/spotlight/message: an effect belongs to
      //     the page that earned it (see applyAction's duration/interaction
      //     handling below); it must not visually persist onto a page whose
      //     shopper never triggered it.
      if (io) io.disconnect();
      elAttn.clear();
      hoveredTarget = null;
      state.scrollSeen = new Set();
      // "navigated" — pathname changed while still showing and untouched
      // (server/RESEARCH.md "Outcomes" section). hideCard()/hideMessage()/
      // clearActiveExecution() report this outcome for whichever of these
      // is actually showing (no-op otherwise).
      clearActiveExecution("navigated");
      hideMessage("navigated");
      // Card navigation-persistence (product rule 2026-09-11), unlike the
      // message bubble above: apply_code/add_to_cart/open_product/search/
      // none survive any navigation (re-anchored to the target on the new
      // page below, or shown as a banner if the target isn't there);
      // pick_size only makes sense on the exact product page it was issued
      // on, so it's cleared (reporting "navigated") on any other navigation.
      // `pagePath` is already updated to the new route at the top of this
      // function.
      if (currentCardCta) {
        if (currentCardCta.kind === "pick_size" && currentCardIssuedPath !== pagePath) {
          hideCard("navigated");
        } else {
          // Card survives — just re-anchor, no outcome to report (it's
          // still live, not resolved). Deferred one rAF (SPA-navigation-
          // layout-race defect class): pushState/replaceState fires this
          // synchronously, often before the SPA has finished repainting the
          // new route's DOM — a same-tick positionCardNow() can measure the
          // target's pre-layout rect. Mirrors web/components/AgentWidget.tsx.
          requestAnimationFrame(safe(positionCardNow));
        }
      }
      discoverTargets();
      sendPageView();
      lastFactsJson = null;
      resetPageViewRateLimit();
      scheduleFactsRun();
    }
    ["pushState", "replaceState"].forEach(function (fn) {
      var orig = history[fn];
      // The whole monkeypatch is safe()-wrapped, not just onRouteChange —
      // this is a patch on a host-page-global (history.pushState/
      // replaceState) that runs on every SPA navigation for the rest of
      // the page's life; any uncaught throw here (from orig.apply or from
      // our own bookkeeping) must never break the host's navigation.
      history[fn] = safe(function () {
        var ret = orig.apply(this, arguments);
        onRouteChange();
        return ret;
      });
    });
    window.addEventListener("popstate", safe(function () {
      emit("back_nav", pagePath);
      onRouteChange();
    }));
    // ----
    setInterval(safe(function () {
      emit("dwell", pagePath, { ms: Date.now() - pageStart });
    }), DWELL_TICK_MS);
    // ---- per-element-dwell-is-viewport-time defect class ------------------
    // An element used to be counted as "dwelled on" purely for being inside
    // the viewport (elVisibleSince below, now replaced), so every
    // above-the-fold element (size guide, size picker, ...) looked exactly
    // like page dwell to the decider — every reader looked like a
    // hesitator. Fixed by switching to ATTENTION time, accumulated only
    // while hovered, focused, tapped, "scrolled into view" (i.e. NOT visible
    // at first paint — see isInViewport — and then intersecting), or within
    // a short heuristic window after a click (a proxy for "opened a modal
    // and is looking at it", since this script can't generally know a modal
    // is open). Identical semantics to web/components/AgentWidget.tsx's
    // TargetAttentionState — keep both in sync.
    var MODAL_HEURISTIC_MS = 15000;
    // per-element-dwell-is-viewport-time defect class (S4): scroll-into-view
    // visibility alone must never grant unbounded attention — a one-shot
    // credit of at most SCROLL_CREDIT_MS total, ever, per target; once
    // spent, only hover/focus/click can still grant attention. Mirrored in
    // web/components/AgentWidget.tsx — keep both in sync.
    var SCROLL_CREDIT_MS = 5000;
    // Reduced-motion defect class: several call sites hardcoded
    // behavior:"smooth" for scrollIntoView, ignoring a shopper's OS-level
    // prefers-reduced-motion setting. scrollBehavior() is the single choke
    // point every scrollIntoView call below goes through. Mirrors
    // web/components/AgentWidget.tsx's prefersReducedMotion()/
    // scrollBehavior().
    function prefersReducedMotion() {
      return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    }
    function scrollBehavior() {
      return prefersReducedMotion() ? "auto" : "smooth";
    }
    // Exit-fade defect class: card/message used to display:none instantly,
    // no exit transition. fadeOutBox hides a box AFTER a short exit
    // animation (class .agx-box-exit, injected in injectStyles), entirely
    // skipped under prefers-reduced-motion. cancelFade must run before a
    // box is reused/re-shown so a pending fade-out timer never hides it
    // again right after it's freshly shown. Mirrors
    // web/components/AgentWidget.tsx's exitingCard/exitingMessage.
    var BOX_EXIT_MS = 120;
    function cancelFade(box) {
      if (box._fadeTimer) { clearTimeout(box._fadeTimer); box._fadeTimer = null; }
      box.classList.remove("is-exiting");
    }
    function fadeOutBox(box) {
      cancelFade(box);
      if (prefersReducedMotion()) {
        box.style.display = "none";
        return;
      }
      box.classList.add("is-exiting");
      box._fadeTimer = setTimeout(function () {
        box.style.display = "none";
        box.classList.remove("is-exiting");
        box._fadeTimer = null;
      }, BOX_EXIT_MS);
    }
    // Card-interrupts-typing defect class: popping a card/message while the
    // shopper is mid-keystroke (search box, promo code field, checkout
    // form) steals visual attention off what they're typing. See
    // isActivelyTyping()/syncTypingSuppression (below, near the card
    // reposition IIFE) for the render-time guard. Mirrors
    // web/components/AgentWidget.tsx.
    var CARD_TYPING_DEFER_MS = 3000;
    function isTypingTarget(node) {
      if (!node || !node.tagName) return false;
      var tag = node.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return true;
      return !!node.isContentEditable;
    }
    function isInViewport(el) {
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      var vw = window.innerWidth || document.documentElement.clientWidth;
      var vh = window.innerHeight || document.documentElement.clientHeight;
      var visibleW = Math.min(r.right, vw) - Math.max(r.left, 0);
      var visibleH = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      if (visibleW <= 0 || visibleH <= 0) return false;
      var area = r.width * r.height;
      return area > 0 && (visibleW * visibleH) / area >= 0.5;
    }
    function scrollCreditTotal(s, now) {
      var live = s.scrollVisibleSince !== null ? now - s.scrollVisibleSince : 0;
      return Math.min(SCROLL_CREDIT_MS, s.scrollCreditMs + live);
    }
    function isTargetActive(s, now) {
      var scrollActive = s.eligibleForScroll && s.scrolledIntoView && s.visible && scrollCreditTotal(s, now) < SCROLL_CREDIT_MS;
      return s.hovering || s.focused || scrollActive || s.modalUntil > now;
    }
    function syncAttention(s, now) {
      var scrollWantsOpen = s.eligibleForScroll && s.scrolledIntoView && s.visible && s.scrollCreditMs < SCROLL_CREDIT_MS;
      if (scrollWantsOpen && s.scrollVisibleSince === null) {
        s.scrollVisibleSince = now;
      } else if (!scrollWantsOpen && s.scrollVisibleSince !== null) {
        s.scrollCreditMs = Math.min(SCROLL_CREDIT_MS, s.scrollCreditMs + (now - s.scrollVisibleSince));
        s.scrollVisibleSince = null;
      }
      var active = isTargetActive(s, now);
      if (active && s.activeSince === null) {
        s.activeSince = now;
      } else if (!active && s.activeSince !== null) {
        s.cumMs += now - s.activeSince;
        s.activeSince = null;
      }
    }
    function attentionTotal(s, now) { return s.cumMs + (s.activeSince !== null ? now - s.activeSince : 0); }
    function hoverTotal(s, now) { return s.hoverMs + (s.hovering ? now - s.hoverSince : 0); }
    function focusTotal(s, now) { return s.focusMs + (s.focused ? now - s.focusSince : 0); }

    // Keyed by target id (not the element — unlike the old elVisibleSince):
    // clicks/hover/focus bookkeeping and the modal heuristic all need to
    // find the SAME record a plain IntersectionObserver callback (which only
    // hands back elements) would create, and id is the stable identity the
    // rest of this file already treats targets by (targetEl(id) resolves the
    // other direction). Kept as a Map (not WeakMap) — the dwell tick below
    // needs to .forEach() over every tracked target.
    var elAttn = new Map();
    function getOrCreateAttn(id, el, now) {
      var s = elAttn.get(id);
      if (!s) {
        var initiallyVisible = el ? isInViewport(el) : false;
        s = {
          initiallyVisible: initiallyVisible,
          eligibleForScroll: !initiallyVisible,
          scrolledIntoView: false,
          visible: false,
          scrollVisibleSince: null,
          scrollCreditMs: 0,
          hovering: false, hoverSince: 0, hoverMs: 0,
          focused: false, focusSince: 0, focusMs: 0,
          clicks: 0,
          modalUntil: 0,
          activeSince: null,
          cumMs: 0,
          lastBucket: 0
        };
        elAttn.set(id, s);
      }
      return s;
    }
    var hoveredTarget = null;

    var io = ("IntersectionObserver" in window) ? new IntersectionObserver(safe(function (entries) {
      var now = Date.now();
      entries.forEach(function (entry) {
        var id = entry.target.getAttribute("data-agent-target");
        if (!id) return;
        var s = getOrCreateAttn(id, entry.target, now);
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          if (s.eligibleForScroll) s.scrolledIntoView = true;
          s.visible = true;
        } else {
          s.visible = false;
        }
        syncAttention(s, now);
      });
    // IO config drift note: this client registers threshold: [0, 0.5, 1]
    // and separately checks `intersectionRatio >= 0.5` on each callback.
    // web/components/AgentWidget.tsx's observer instead registers a single
    // threshold (0.5) and reads `entry.isIntersecting` directly. Both are
    // semantically equivalent for "visible" (each fires exactly at the 50%
    // crossing either way) — this is a known, INTENTIONAL difference
    // between the two implementations, not something to "align" into an
    // actual behavioral mismatch; if you touch one, verify the other still
    // means the same thing.
    }), { threshold: [0, 0.5, 1] }) : null;
    function observeTargets() {
      if (!io) return;
      var now = Date.now();
      state.targets.forEach(function (id) {
        var el = targetEl(id);
        if (!el) return;
        // Synchronous creation (mirrors web/components/AgentWidget.tsx) is
        // what makes `initiallyVisible` mean "visible at first paint": a
        // target seen for the first time ever on this page is checked
        // against the DOM's current layout right now, before the async IO
        // callback (and before any scroll) can happen. A target discovered
        // later (e.g. a modal's contents) is not "at first paint" even if
        // already visible the instant it's discovered.
        getOrCreateAttn(id, el, now);
        io.observe(el);
      });
    }
    observeTargets();
    var origDiscover = discoverTargets;
    discoverTargets = function () { var c = origDiscover(); observeTargets(); return c; };

    // Per-element dwell: fires every 3s of cumulative ATTENTION for EVERY
    // tracked target crossing a bucket boundary (not just the single
    // largest currently-visible element, the old behavior — that undercounted
    // and drifted from the React widget's per-target semantics). Also the
    // only place a modal-heuristic window's expiry (time passing with no new
    // event) gets observed, via syncAttention().
    var touch = isCoarsePointer();
    setInterval(safe(function () {
      var now = Date.now();
      elAttn.forEach(function (s, id) {
        syncAttention(s, now);
        var total = attentionTotal(s, now);
        if (total <= 0) return;
        var bucket = Math.floor(total / 3000);
        if (bucket > s.lastBucket && total >= 3000) {
          s.lastBucket = bucket;
          var meta = {
            ms: total,
            kind: "attention",
            interactions: {
              hover_ms: Math.round(hoverTotal(s, now)),
              focus_ms: Math.round(focusTotal(s, now)),
              clicks: s.clicks,
              scrolled_to: s.scrolledIntoView
            }
          };
          if (touch) meta.touch = true;
          emit("dwell", id, meta);
        }
      });
    }), 3000);

    // Attention: hover (pointerover/pointerout delegation — bubbling events,
    // unlike mouseenter/mouseleave, so one document-level listener covers
    // every current and future [data-agent-target] element). Touch devices
    // have no hover; taps still count via the click handler below (see
    // meta.touch, computed from matchMedia("(pointer: coarse)")).
    document.addEventListener("pointerover", safe(function (e) {
      var el = e.target && e.target.closest ? e.target.closest("[data-agent-target]") : null;
      var id = el ? el.getAttribute("data-agent-target") : null;
      if (id === hoveredTarget) return;
      var now = Date.now();
      if (hoveredTarget) {
        var prev = elAttn.get(hoveredTarget);
        if (prev && prev.hovering) {
          prev.hoverMs += now - prev.hoverSince;
          prev.hovering = false;
          syncAttention(prev, now);
        }
      }
      hoveredTarget = id;
      if (id && el) {
        var s = getOrCreateAttn(id, el, now);
        s.hovering = true;
        s.hoverSince = now;
        syncAttention(s, now);
      }
    }));
    document.addEventListener("pointerout", safe(function (e) {
      if (!hoveredTarget) return;
      var related = e.relatedTarget;
      if (related && related.closest && related.closest('[data-agent-target="' + cssEscape(hoveredTarget) + '"]')) return;
      var now = Date.now();
      var prev = elAttn.get(hoveredTarget);
      if (prev && prev.hovering) {
        prev.hoverMs += now - prev.hoverSince;
        prev.hovering = false;
        syncAttention(prev, now);
      }
      hoveredTarget = null;
    }));

    // Attention: focus (focusin/focusout — the bubbling counterparts of
    // focus/blur — delegation, so "the target or a descendant has focus"
    // works for a target that's a container around a real form control).
    document.addEventListener("focusin", safe(function (e) {
      var el = e.target && e.target.closest ? e.target.closest("[data-agent-target]") : null;
      if (!el) return;
      var id = el.getAttribute("data-agent-target");
      var now = Date.now();
      var s = getOrCreateAttn(id, el, now);
      if (!s.focused) {
        s.focused = true;
        s.focusSince = now;
        syncAttention(s, now);
      }
    }));
    document.addEventListener("focusout", safe(function (e) {
      var el = e.target && e.target.closest ? e.target.closest("[data-agent-target]") : null;
      if (!el) return;
      var id = el.getAttribute("data-agent-target");
      var s = elAttn.get(id);
      if (!s || !s.focused) return;
      var related = e.relatedTarget;
      if (related && related.closest && related.closest('[data-agent-target="' + cssEscape(id) + '"]') === el) return;
      var now = Date.now();
      s.focusMs += now - s.focusSince;
      s.focused = false;
      syncAttention(s, now);
    }));
    // ----
    window.addEventListener("scroll", safe(function () {
      var doc = document.documentElement;
      var scrolled = doc.scrollTop + window.innerHeight;
      var total = doc.scrollHeight || 1;
      var pct = Math.min(100, Math.round((scrolled / total) * 100));
      [25, 50, 75, 100].forEach(function (mark) {
        if (pct >= mark && !state.scrollSeen.has(mark)) {
          state.scrollSeen.add(mark);
          emit("scroll_depth", pagePath, { pct: mark });
        }
      });
    }), { passive: true });
    // ----
    // Fixed-short-effect-lifetime defect class: an active highlight/spotlight
    // used to be dismissed by ANY click anywhere on the page, including an
    // incidental click that has nothing to do with the effect — with a slow
    // (15-22s live) decider, a shopper who clicks something else while
    // reading is punished by losing help they hadn't even seen yet. Now an
    // effect ends on the EARLIEST of: its duration, an interaction with it
    // (clicking its own target, or its own agent-UI dismiss controls — those
    // call clearActiveExecution() directly, see ensureHighlightChip/
    // ensureMessageBox above), or navigation away (onRouteChange above) —
    // never earlier. An unrelated click elsewhere on the page still counts
    // as "the shopper is doing something else" and dismisses the effect,
    // but only once it's had EFFECT_GRACE_MS to actually be seen, so a
    // single accidental click right after the effect lands can't kill it.
    var EFFECT_GRACE_MS = 5000;
    document.addEventListener("click", safe(function (e) {
      // Own UI (bubble, chip, pill, panel — all data-agx-ui) is not a page
      // click: never dismisses the effect it belongs to (explicit dismiss
      // buttons already call clearActiveExecution()/hideMessage() directly),
      // never a rage click.
      if (isOwnUI(e.target)) return;
      var el = e.target && e.target.closest ? e.target.closest("[data-agent-target]") : null;
      var hasActiveEffect = state.activeHighlights.length > 0 || !!state.spotlightEl;
      if (hasActiveEffect) {
        var isActiveTargetClick = !!el && (
          state.activeHighlights.some(function (h) { return h.el === el; }) ||
          state.spotlightEl === el
        );
        var elapsedSinceEffect = Date.now() - (state.lastEffectAt || 0);
        if (isActiveTargetClick || elapsedSinceEffect >= EFFECT_GRACE_MS) {
          clearActiveExecution();
        }
      }
      if (!el) return;
      var id = el.getAttribute("data-agent-target");
      var now = Date.now();

      // Attention: modal-open heuristic. This script can't generally tell a
      // click opened a dialog (e.g. the size guide modal) — a click followed
      // by no navigation is treated as "shopper is now engaging with
      // whatever that click produced" for MODAL_HEURISTIC_MS, UNLESS a
      // DIFFERENT target is interacted with first (cancelled below on every
      // other target's click). Navigation itself already clears elAttn
      // entirely (onRouteChange), so no separate "did not navigate" check.
      // syncAttention's own contract ("call after any mutation to the
      // fields isTargetActive() reads") applies to modalUntil too — without
      // this, a target whose "active" window was open only because of its
      // own modal-heuristic window stays open until the next periodic
      // dwellTick sync, over-counting attention past the moment a different
      // target's click actually ended it.
      elAttn.forEach(function (s, key) {
        if (key === id) return;
        s.modalUntil = 0;
        syncAttention(s, now);
      });
      var attnState = getOrCreateAttn(id, el, now);
      attnState.clicks += 1;
      attnState.modalUntil = now + MODAL_HEURISTIC_MS;
      syncAttention(attnState, now);

      var arr = state.clickBursts.get(el) || [];
      arr = arr.filter(function (t) { return now - t <= 1500; });
      arr.push(now);
      state.clickBursts.set(el, arr);
      if (arr.length >= 3) {
        emit("rage_click", id, { count: arr.length });
        state.clickBursts.set(el, []);
      }
      // A bare emit("cart_update", id) used to fire here with no meta right
      // before maybeEmitCart()'s real, cart-state-carrying emit — a
      // consumer reading events in order could see a phantom
      // total:undefined/0 cart_update immediately followed by the real one.
      // maybeEmitCart() below is the single source of truth for cart
      // events; clicking any target never needs its own separate emit.
      maybeEmitCart();
    }), true);
    // ---- back_nav via browser back button already covered by popstate above -
    // ----
    // Input types/autocomplete values that must NEVER have their value read
    // or sent, even if the field's name/id happens to look search-like —
    // this is a hard exclusion checked before the search heuristic, not an
    // alternative to it.
    var SEARCH_EXCLUDED_TYPES = ["password", "email", "tel", "number", "hidden"];
    function isSensitiveInput(el) {
      var type = String(el.type || "text").toLowerCase();
      if (SEARCH_EXCLUDED_TYPES.indexOf(type) !== -1) return true;
      var autocomplete = String(el.getAttribute && el.getAttribute("autocomplete") || "").toLowerCase();
      return autocomplete.indexOf("cc-") !== -1 || autocomplete.indexOf("one-time-code") !== -1;
    }
    // Search-input-only-fires-on-Enter defect class: a search box that
    // filters live client-side as the shopper types (Acme — no
    // Enter/submit at all) used to never emit `search` because the only
    // listener was a keydown-Enter one. isSearchInput() is the single
    // predicate every emission path below (Enter, debounced input, form
    // submit) uses to decide whether an <input> is a search box: explicit
    // type="search", a name/id that looks search-like, OR an explicit
    // data-agent-target="search" wiring — any one qualifies.
    function isSearchInput(el) {
      if (!el || !el.tagName || el.tagName !== "INPUT") return false;
      if (isSensitiveInput(el)) return false;
      var isSearchType = el.type === "search";
      var nameOrId = ((el.name || "") + " " + (el.id || "")).toLowerCase();
      var looksLikeSearch = /search|(^|[^a-z])q([^a-z]|$)/.test(nameOrId);
      var isAgentTarget = el.getAttribute && el.getAttribute("data-agent-target") === "search";
      return isSearchType || looksLikeSearch || isAgentTarget;
    }
    // ---- search result counts (server/contracts.js's `search` meta.results)
    // A search event with no result count can't drive the zero-result-search
    // card (server/gate.js's searchFriction / server/store/index.js's
    // search_help both require an EXACT 0, never absent/undefined). No host
    // page wires this up explicitly — instead any page may expose the count
    // as a data-agent-search-results="<n>" attribute, checked in this order:
    // the search input itself, its closest <form>, then anywhere else on the
    // page (a results header/container). Both client-side-filtered result
    // lists (attribute updates in place, no navigation — e.g. Acme)
    // and SSR results pages (attribute present on load after a navigation —
    // e.g. NextCart's /search?q=...) are covered: this reads the attribute
    // immediately AND watches it via MutationObserver for up to 5s. A
    // resulting `search` re-emit with the discovered count is expected and
    // deduped by (target, q, results) the same way cart_update dedupes by
    // (total, items.length) in maybeEmitCart() above — never re-emits the
    // exact same count for the exact same query twice in a row.
    var SEARCH_RESULTS_ATTR = "data-agent-search-results";
    var searchResultsObserver = null;
    var searchResultsTimer = null;
    var lastSearchResultsKey = null;
    // Dedupe for the base `search` emit (no results yet) — separate from
    // lastSearchResultsKey above, which dedupes the results-carrying
    // re-emit. Without this, retyping the identical query after the
    // debounce window elapsed again would re-emit the exact same
    // (target, q) pair with no new information.
    var lastEmittedSearchQueryKey = null;
    function emitSearchQuery(target, q) {
      var key = (target || "") + "|" + q;
      if (key === lastEmittedSearchQueryKey) return;
      lastEmittedSearchQueryKey = key;
      emit("search", target || null, { q: q });
    }
    function parseResultsCount(v) {
      if (v == null) return null;
      var n = parseInt(String(v).replace(/[^0-9\-]/g, ""), 10);
      return isNaN(n) ? null : n;
    }
    function readSearchResultsCount(inputEl) {
      var el = null;
      if (inputEl && inputEl.hasAttribute && inputEl.hasAttribute(SEARCH_RESULTS_ATTR)) {
        el = inputEl;
      } else if (inputEl && inputEl.closest) {
        var form = inputEl.closest("form");
        if (form && form.hasAttribute(SEARCH_RESULTS_ATTR)) el = form;
      }
      if (!el) el = document.querySelector("[" + SEARCH_RESULTS_ATTR + "]");
      if (!el) return null;
      return parseResultsCount(el.getAttribute(SEARCH_RESULTS_ATTR));
    }
    function stopSearchResultsWatch() {
      if (searchResultsObserver) { searchResultsObserver.disconnect(); searchResultsObserver = null; }
      if (searchResultsTimer) { clearTimeout(searchResultsTimer); searchResultsTimer = null; }
    }
    function emitSearchResultsIfChanged(target, q, results) {
      if (results == null) return;
      var key = (target || "") + "|" + q + "|" + results;
      if (key === lastSearchResultsKey) return;
      lastSearchResultsKey = key;
      emit("search", target || null, { q: q, results: results });
    }
    function watchSearchResults(target, q, inputEl) {
      stopSearchResultsWatch();
      var immediate = readSearchResultsCount(inputEl);
      if (immediate != null) emitSearchResultsIfChanged(target, q, immediate);
      try {
        searchResultsObserver = new MutationObserver(safe(function () {
          var n = readSearchResultsCount(inputEl);
          if (n != null) emitSearchResultsIfChanged(target, q, n);
        }));
        searchResultsObserver.observe(document.body, {
          attributes: true,
          attributeFilter: [SEARCH_RESULTS_ATTR],
          subtree: true
        });
      } catch (err) { /* MutationObserver unsupported — best effort only */ }
      searchResultsTimer = setTimeout(safe(stopSearchResultsWatch), 5000);
    }
    // Route-driven search (server/contracts.js): a page_view on a URL
    // carrying ?q= (NextCart's SSR /search?q=... results page, reached via
    // navigation rather than an in-page keystroke) must still produce a
    // `search` event — there is no <input> keydown to hang it off of.
    // Called from sendPageView() below, so it runs on boot, every SPA
    // navigation, and every rate-limited page_view resend; the (target, q,
    // results) dedupe above keeps repeats silent.
    function checkRouteSearch() {
      var qs;
      try { qs = new URLSearchParams(location.search); } catch (err) { qs = null; }
      var q = qs ? qs.get("q") : null;
      if (q == null || !String(q).trim()) { stopSearchResultsWatch(); return; }
      watchSearchResults(null, String(q).slice(0, 200), null);
    }
    // Explicit-action path: Enter always emits immediately, regardless of
    // length — the shopper has unambiguously submitted the query. Cancels
    // any pending debounce timer for the same input so a stale shorter-q
    // emit doesn't land right after this one.
    document.addEventListener("keydown", safe(function (e) {
      if (e.key !== "Enter") return;
      var el = e.target;
      if (!isSearchInput(el)) return;
      var pendingTimer = searchInputDebounceTimers.get(el);
      if (pendingTimer) { clearTimeout(pendingTimer); searchInputDebounceTimers.delete(el); }
      var q = String(el.value || "").slice(0, 200);
      var target = el.getAttribute("data-agent-target") || null;
      emitSearchQuery(target, q);
      watchSearchResults(target, q, el);
    }), true);
    // Live-filter path (Acme etc.): no Enter/submit at all — the
    // shop filters as the shopper types. Debounced ~700ms after the last
    // keystroke, min 2 chars (avoids emitting on every single first
    // keystroke of a still-forming query). The (target, q) dedupe in
    // emitSearchQuery + the (target, q, results) dedupe in
    // emitSearchResultsIfChanged together mean re-emits only happen when
    // something actually changed. Mirrors web/components/AgentWidget.tsx.
    var SEARCH_INPUT_DEBOUNCE_MS = 700;
    var SEARCH_INPUT_MIN_CHARS = 2;
    var searchInputDebounceTimers = new WeakMap();
    document.addEventListener("input", safe(function (e) {
      var el = e.target;
      if (!isSearchInput(el)) return;
      var pending = searchInputDebounceTimers.get(el);
      if (pending) clearTimeout(pending);
      var timer = setTimeout(safe(function () {
        searchInputDebounceTimers.delete(el);
        var q = String(el.value || "").slice(0, 200);
        if (q.length < SEARCH_INPUT_MIN_CHARS) return;
        var target = el.getAttribute("data-agent-target") || null;
        emitSearchQuery(target, q);
        watchSearchResults(target, q, el);
      }), SEARCH_INPUT_DEBOUNCE_MS);
      searchInputDebounceTimers.set(el, timer);
    }), true);
    // Submit path: <input type="search"> (or any qualifying search input)
    // inside a <form> that's submitted rather than live-filtered.
    document.addEventListener("submit", safe(function (e) {
      var form = e.target;
      if (!form || !form.querySelectorAll) return;
      var inputs = form.querySelectorAll("input");
      for (var i = 0; i < inputs.length; i++) {
        var el = inputs[i];
        if (!isSearchInput(el)) continue;
        var pendingTimer2 = searchInputDebounceTimers.get(el);
        if (pendingTimer2) { clearTimeout(pendingTimer2); searchInputDebounceTimers.delete(el); }
        var q = String(el.value || "").slice(0, 200);
        var target = el.getAttribute("data-agent-target") || null;
        emitSearchQuery(target, q);
        watchSearchResults(target, q, el);
        break;
      }
    }), true);
    // ----
    // Escape-only-closes-the-panel defect class: Escape used to be wired up
    // ONLY while the assist panel was open (closing it) — a live card or
    // message bubble had no keyboard dismissal at all. This listener is
    // attached once, for the page's whole life, and dismisses whichever of
    // card/message is currently showing (reports "dismiss", same as the ×
    // button) whenever the panel itself isn't open (the panel's own
    // Escape-closes-it handler, assistKeydownHandler, takes priority while
    // it's open). Mirrors web/components/AgentWidget.tsx.
    document.addEventListener("keydown", safe(function (e) {
      if (e.key !== "Escape" || state.assistOpen) return;
      if (currentCardId && cardBoxEl && cardBoxEl.style.display !== "none") { hideCard("dismiss"); return; }
      if (currentMessageId && messageBoxEl && messageBoxEl.style.display !== "none") hideMessage("dismiss");
    }));
    // ----
    // Outcome tracking (server/RESEARCH.md "Outcomes" section): "ignored" —
    // whichever of card/message/highlight-spotlight is still showing when
    // the tab goes away, never having been dismissed/CTA'd/turned-off/
    // navigated away from. reportOutcomeOnce is idempotent, so this never
    // double-reports something already resolved another way.
    function reportIfStillShowing() {
      if (currentCardId) reportOutcomeOnce(currentCardId, "ignored", currentCardShownAt);
      if (currentMessageId) reportOutcomeOnce(currentMessageId, "ignored", currentMessageShownAt);
      state.activeHighlights.forEach(function (h) { reportOutcomeOnce(h.actionId, "ignored", h.shownAt); });
      if (state.spotlightEl) reportOutcomeOnce(state.spotlightActionId, "ignored", state.spotlightShownAt);
    }
    document.addEventListener("visibilitychange", safe(function () {
      if (document.visibilityState === "hidden") reportIfStillShowing();
    }));
    window.addEventListener("pagehide", safe(reportIfStillShowing));
    // ----
    var lastCartSnapshot = null;
    function readCart() {
      if (window.__agentCart && typeof window.__agentCart === "object") {
        var c = window.__agentCart;
        return { total: Number(c.total) || 0, items: Array.isArray(c.items) ? c.items : [] };
      }
      var totalEl = document.querySelector("[data-agent-cart-total]");
      if (totalEl) {
        var total = parseFloat((totalEl.getAttribute("data-agent-cart-total") || totalEl.textContent || "0").replace(/[^0-9.\-]/g, ""));
        return { total: isNaN(total) ? 0 : total, items: [] };
      }
      return null; // no cart exposed — skip cart events entirely
    }
    function maybeEmitCart(isView) {
      var cart = readCart();
      if (!cart) return;
      var key = cart.total + ":" + cart.items.length;
      if (isView) {
        emit("cart_view", null, cart);
        lastCartSnapshot = key;
        return;
      }
      if (key !== lastCartSnapshot) {
        lastCartSnapshot = key;
        emit("cart_update", null, cart);
      }
    }
    if (readCart()) maybeEmitCart(true);
    // ----
    // reason: outcome to report (server/RESEARCH.md "Outcomes" section),
    // default "dismiss" (chip ×, on-target/elsewhere click). Reports for
    // EVERY currently-tracked highlight AND the spotlight (if any) — this
    // embed supports multiple simultaneous highlights (unlike the
    // single-slot React widget), so a shared clear-everything action
    // resolves all of their ids at once, each via reportOutcomeOnce (a
    // no-op for any id already reported).
    function clearActiveExecution(reason) {
      reason = reason || "dismiss";
      state.activeHighlights.forEach(function (h) {
        if (h.timer) clearTimeout(h.timer);
        h.el.classList.remove(h.cls);
        reportOutcomeOnce(h.actionId, reason, h.shownAt);
        markSuggestionResolved(h.actionId, reason);
      });
      state.activeHighlights = [];
      if (state.spotlightEl) {
        if (state.spotlightTimer) { clearTimeout(state.spotlightTimer); state.spotlightTimer = null; }
        document.body.classList.remove("agx-dim");
        state.spotlightEl.classList.remove("agx-spotlight");
        reportOutcomeOnce(state.spotlightActionId, reason, state.spotlightShownAt);
        markSuggestionResolved(state.spotlightActionId, reason);
        state.spotlightEl = null;
        state.spotlightActionId = null;
        state.spotlightShownAt = 0;
      }
      hideHighlightChip();
    }

    // "Why?" line shared by the message bubble and the highlight chip: most
    // recent trace's hypothesis (fallback why) + confidence as a percentage.
    // Mirrored in web/components/AgentWidget.tsx's traceWhyText().
    function computeWhyText() {
      var t = state.traces[0];
      if (!t) return "";
      var basis = t.hypothesis || t.why || "";
      if (!basis) return "";
      var pct = Math.round((t.confidence || 0) * 100);
      return basis + " · " + pct + "% sure";
    }

    var messageBoxEl = null;
    function ensureMessageBox() {
      if (messageBoxEl) return messageBoxEl;
      messageBoxEl = el("div", "agx-message");
      messageBoxEl.style.display = "none";
      messageBoxEl.setAttribute("role", "status");
      messageBoxEl.setAttribute("aria-live", "polite");

      var row = el("div", "agx-message-row");
      var span = el("span");
      var dismissBtn = el("button", null, "×");
      dismissBtn.type = "button";
      dismissBtn.setAttribute("aria-label", "Dismiss");
      dismissBtn.addEventListener("click", safe(function () { hideMessage(); }));
      row.appendChild(span);
      row.appendChild(dismissBtn);

      var footer = el("div", "agx-message-footer");
      var whyBtn = el("button", "agx-why-toggle", "Why?");
      whyBtn.type = "button";
      whyBtn.setAttribute("aria-expanded", "false");
      var turnOffBtn = el("button", "agx-turnoff", "Turn off");
      turnOffBtn.type = "button";
      turnOffBtn.addEventListener("click", safe(function () { setEnabled(false); }));
      footer.appendChild(whyBtn);
      footer.appendChild(turnOffBtn);

      var whyLine = el("div", "agx-why-line");
      whyLine.style.display = "none";
      whyBtn.addEventListener("click", safe(function () {
        var open = whyLine.style.display !== "none";
        if (open) {
          whyLine.style.display = "none";
          whyBtn.setAttribute("aria-expanded", "false");
        } else {
          whyLine.textContent = computeWhyText();
          whyLine.style.display = "block";
          whyBtn.setAttribute("aria-expanded", "true");
        }
      }));

      messageBoxEl.appendChild(row);
      messageBoxEl.appendChild(footer);
      messageBoxEl.appendChild(whyLine);
      document.body.appendChild(messageBoxEl);
      messageBoxEl._span = span;
      messageBoxEl._whyLine = whyLine;
      messageBoxEl._whyBtn = whyBtn;
      return messageBoxEl;
    }
    // currentMessageId/currentMessageShownAt: outcome tracking (server/
    // RESEARCH.md "Outcomes" section) — mirrors currentCardCta's pattern.
    var currentMessageId = null;
    var currentMessageShownAt = 0;
    function renderMessage(text, actionId) {
      var box = ensureMessageBox();
      cancelFade(box);
      box._span.textContent = text.slice(0, 140);
      box._whyLine.style.display = "none";
      box._whyBtn.setAttribute("aria-expanded", "false");
      box.style.display = "flex";
      if (state.messageTimer) clearTimeout(state.messageTimer);
      currentMessageId = actionId || null;
      currentMessageShownAt = Date.now();
    }
    // reason: outcome to report, default "dismiss" (× button).
    function hideMessage(reason) {
      if (messageBoxEl && messageBoxEl.style.display !== "none") {
        fadeOutBox(messageBoxEl);
        messageBoxEl._whyLine.style.display = "none";
        messageBoxEl._whyBtn.setAttribute("aria-expanded", "false");
      }
      if (state.messageTimer) { clearTimeout(state.messageTimer); state.messageTimer = null; }
      if (currentMessageId) {
        reportOutcomeOnce(currentMessageId, reason || "dismiss", currentMessageShownAt);
        markSuggestionResolved(currentMessageId, reason || "dismiss");
      }
      currentMessageId = null;
    }

    // On-page "card" action box — anchored next to its target (or a top
    // banner if the target isn't on this page / the viewport is narrow, see
    // positionCardNow()/computeCardPosition() below), same shape (own box,
    // ×, Why?, Turn off), but with a title + CTA button instead of a plain
    // sentence. See the file header comment for the CTA executor and the
    // no-auto-expiry rule. Mirrors web/components/AgentWidget.tsx.
    var cardBoxEl = null;
    var currentCardCta = null; // the currently-shown card's cta, read by the CTA button's click handler
    // currentCardId/currentCardShownAt: outcome tracking (server/RESEARCH.md
    // "Outcomes" section).
    var currentCardId = null;
    var currentCardShownAt = 0;
    var currentCardTarget = null; // the currently-shown card's a.target, read by positionCardNow()
    var currentCardIssuedPath = null; // pagePath at the time the card was shown — pick_size navigation rule below
    var cardPollTimer = null;
    var CARD_MAX_WIDTH = 360;
    var CARD_MARGIN = 12;
    var CARD_MOBILE_BREAKPOINT = 480;

    // Card-occludes-recommended-element defect class: computeCardPosition
    // used to place the card at rect.bottom+10 unconditionally, so a card
    // recommending an "Add to cart" or "Try size L" button can land right
    // on top of it (or another interactive element), soaking up the tap it
    // was trying to earn. rectsOverlap/interactiveOcclusionCandidates/
    // intersectingCandidates below check the placed card against every
    // other on-page interactive element actually visible in the viewport
    // before committing to a position. Take 2: the original fix only
    // checked `[data-agent-target], button, a` (missed `input`/`select`/
    // ARIA buttons) and, when both the flip and the sideways offset still
    // occluded something, silently kept the ORIGINAL occluding placement
    // instead of the best alternative tried — indistinguishable from never
    // checking at all. See computeCardPosition below for the fixed
    // try-in-order resolution. Mirrored in web/components/AgentWidget.tsx.
    function rectsOverlap(a, b) {
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    }
    function interactiveOcclusionCandidates(excludeEls) {
      var all = document.querySelectorAll('button, a, input, select, [role="button"], [data-agent-target]');
      var exclusions = [];
      for (var i = 0; i < excludeEls.length; i++) {
        if (excludeEls[i]) exclusions.push(excludeEls[i]);
      }
      var out = [];
      outer: for (var j = 0; j < all.length; j++) {
        var candidate = all[j];
        for (var k = 0; k < exclusions.length; k++) {
          var ex = exclusions[k];
          if (candidate === ex || ex.contains(candidate) || candidate.contains(ex)) continue outer;
        }
        out.push(candidate);
      }
      return out;
    }
    function intersectingCandidates(viewportRect, candidates) {
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var hits = [];
      for (var i = 0; i < candidates.length; i++) {
        var candidate = candidates[i];
        var r = candidate.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue; // not on screen — can't be occluded
        if (rectsOverlap(viewportRect, r)) hits.push(candidate);
      }
      return hits;
    }
    // Card-over-modal occlusion defect class (finding A): unlike
    // cardOccludesInteractive above (used to CHOOSE a position before the
    // card is shown), a host-page modal opening over the target AFTER the
    // card is already anchored can't be dodged by repositioning — the card
    // would just cover the modal (and its own Close button) wherever it
    // goes. isTargetOccluded checks whether the target is still the
    // topmost element at its own centre point; positionCardNow's poll
    // hides the card (state kept) while it isn't, and re-shows it once it
    // is again. Mirrored in web/components/AgentWidget.tsx.
    function isTargetOccluded(targetElNode) {
      var r = targetElNode.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false; // off-screen, not a modal case
      var hit = document.elementFromPoint(cx, cy);
      if (!hit) return false;
      return hit !== targetElNode && !targetElNode.contains(hit) && !hit.contains(targetElNode);
    }
    function computeCardPosition(target) {
      if (window.innerWidth < CARD_MOBILE_BREAKPOINT) return { mode: "banner" };
      var targetElNode = target ? targetEl(target) : null;
      if (!targetElNode) return { mode: "banner" };
      var rect = targetElNode.getBoundingClientRect();
      var cardW = (cardBoxEl && cardBoxEl.offsetWidth) || CARD_MAX_WIDTH;
      var cardH = (cardBoxEl && cardBoxEl.offsetHeight) || 140;
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var spaceBelow = vh - rect.bottom;
      var spaceAbove = rect.top;
      var fitsBelow = spaceBelow >= cardH + CARD_MARGIN + 10;
      var fitsAbove = spaceAbove >= cardH + CARD_MARGIN + 10;
      // Below by default; only flips above when below doesn't fit but above
      // does. This is purely the space-fit heuristic — occlusion is
      // resolved separately below and always wins over this preference.
      var preferBelow = fitsBelow || !fitsAbove;

      function clampLeft(l) {
        var minLeft = window.scrollX + CARD_MARGIN;
        var maxLeft = window.scrollX + vw - cardW - CARD_MARGIN;
        return Math.max(minLeft, Math.min(l, maxLeft));
      }
      function clampTop(t) {
        return Math.max(window.scrollY + CARD_MARGIN, t);
      }
      function below() {
        return { top: clampTop(rect.bottom + window.scrollY + 10), left: clampLeft(rect.left + window.scrollX), caret: "top" };
      }
      function above() {
        return { top: clampTop(rect.top + window.scrollY - cardH - 10), left: clampLeft(rect.left + window.scrollX), caret: "bottom" };
      }
      function rightOf() {
        var l = rect.right + window.scrollX + 10;
        if (l + cardW > window.scrollX + vw - CARD_MARGIN) return null;
        return { top: clampTop(rect.top + window.scrollY), left: l, caret: preferBelow ? "top" : "bottom" };
      }
      function leftOf() {
        var l = rect.left + window.scrollX - cardW - 10;
        if (l < window.scrollX + CARD_MARGIN) return null;
        return { top: clampTop(rect.top + window.scrollY), left: l, caret: preferBelow ? "top" : "bottom" };
      }
      // Last resort: stay below the target, but push down past the bottom
      // edge of every interactive element the default "below" spot
      // actually hit — guarantees the CTA(s) that caused the occlusion are
      // cleared.
      function offsetBelow(hits) {
        var maxBottom = rect.bottom;
        for (var i = 0; i < hits.length; i++) {
          var r = hits[i].getBoundingClientRect();
          if (r.bottom > maxBottom) maxBottom = r.bottom;
        }
        return { top: clampTop(maxBottom + window.scrollY + 10), left: clampLeft(rect.left + window.scrollX), caret: "top" };
      }
      function viewportRectOf(p) {
        var vt = p.top - window.scrollY;
        var vl = p.left - window.scrollX;
        return { top: vt, left: vl, right: vl + cardW, bottom: vt + cardH };
      }

      var candidates = interactiveOcclusionCandidates([targetElNode, cardBoxEl]);
      var initialPos = preferBelow ? below() : above();
      var chosen = initialPos;
      var placement = preferBelow ? "below" : "above";
      var hits = intersectingCandidates(viewportRectOf(initialPos), candidates);
      if (hits.length > 0) {
        var tryOrder = [
          [preferBelow ? "above" : "below", preferBelow ? above : below],
          ["right", rightOf],
          ["left", leftOf],
        ];
        var resolved = false;
        for (var t = 0; t < tryOrder.length; t++) {
          var mode = tryOrder[t][0];
          var fn = tryOrder[t][1];
          var pos = fn();
          if (!pos) continue;
          if (intersectingCandidates(viewportRectOf(pos), candidates).length === 0) {
            chosen = pos;
            placement = mode;
            resolved = true;
            break;
          }
        }
        if (!resolved) {
          chosen = offsetBelow(hits);
          placement = "offset";
        }
      }

      var top = chosen.top;
      var left = chosen.left;
      var caretTargetX = rect.left + window.scrollX + Math.min(rect.width, 32) / 2;
      var caretLeft = Math.max(16, Math.min(cardW - 16, caretTargetX - left));
      return { mode: "anchored", top: top, left: left, caret: chosen.caret, caretLeft: caretLeft, placement: placement };
    }
    /** Re-anchors (or re-banners) the live card against its current target.
     * Called right after a card is shown, on a 250ms poll while one is
     * showing (covers target layout shifts without a MutationObserver), on
     * resize/scroll (rAF-throttled), on window `load`, and again on route
     * change. Does NOT scroll — scrolling into view happens exactly once,
     * at renderCard() time (see scroll-jail defect: re-scrolling on every
     * poll/scroll tick yanks a shopper back who deliberately scrolled
     * away). Mirrors web/components/AgentWidget.tsx. */
    function positionCardNow() {
      if (!cardBoxEl || cardBoxEl.style.display === "none") return;
      // Refresh the CTA's already-selected state too (card look #3) — the
      // shopper can pick a size by hand, outside the card, while it's still
      // showing; this poll tick is what notices. Diffed inside
      // renderCardCta itself so an unconditional 250ms poll doesn't rewrite
      // unchanged DOM/text every tick.
      renderCardCta(cardBoxEl, currentCardCta);
      var targetElNode = currentCardTarget ? targetEl(currentCardTarget) : null;
      if (currentCardTarget && !targetElNode) {
        // Target element removed from the page since the card was shown —
        // don't leave a permanent top banner pointing at nothing; hide as
        // "ignored" (never interacted with) instead.
        hideCard("ignored");
        return;
      }
      // Card-over-modal occlusion defect class (finding A): hide (state
      // kept) while a host-page overlay covers the target — see
      // isTargetOccluded — instead of stacking the card visually on top of
      // whatever now covers it (a modal's Close button, say).
      cardBoxEl.classList.toggle("is-target-occluded", !!(targetElNode && isTargetOccluded(targetElNode)));
      var pos = computeCardPosition(currentCardTarget);
      cardBoxEl.classList.remove("is-anchored", "is-banner", "caret-top", "caret-bottom");
      if (pos.mode === "anchored") {
        cardBoxEl.classList.add("is-anchored", "caret-" + pos.caret);
        cardBoxEl.style.top = pos.top + "px";
        cardBoxEl.style.left = pos.left + "px";
        cardBoxEl.style.setProperty("--agx-caret-left", pos.caretLeft + "px");
        cardBoxEl.setAttribute("data-agent-card-placement", pos.placement);
      } else {
        cardBoxEl.classList.add("is-banner");
        cardBoxEl.style.top = "";
        cardBoxEl.style.left = "";
        cardBoxEl.removeAttribute("data-agent-card-placement");
      }
    }
    /** Card look #3 (mirrors web/components/AgentWidget.tsx's
     * pickSizeCurrentlySelected): if a size-picker button matching cta.value
     * already reports aria-pressed="true", the CTA is a no-op tap — the
     * caller shows an already-selected state instead. Best-effort only: a
     * host page that doesn't use the `[data-agent-target="size-picker"]` +
     * per-button aria-pressed convention just never matches, and the normal
     * CTA button renders instead. */
    function pickSizeCurrentlySelected(value) {
      if (!value) return false;
      var picker = document.querySelector('[data-agent-target="size-picker"]');
      if (!picker) return false;
      var buttons = picker.querySelectorAll("button");
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].textContent && buttons[i].textContent.trim() === value) {
          return buttons[i].getAttribute("aria-pressed") === "true";
        }
      }
      return false;
    }
    // Entry-animation-plays-once defect class: ensureCardBox reuses one DOM
    // node for every card (display:none -> flex does NOT restart a CSS
    // animation already attached to a class that stays on the element), so
    // the agx-card-in entry animation only ever played for the very first
    // card shown in a session. Force-restart it by clearing the inline
    // `animation` override, forcing a reflow, then clearing it again so the
    // CSS class's own `animation:` declaration re-applies from scratch.
    // Mirrors web/components/AgentWidget.tsx (React remounts the node on a
    // key change instead, which has the same effect).
    function restartCardEntryAnimation(box) {
      box.style.animation = "none";
      void box.offsetWidth; // force reflow
      box.style.animation = "";
    }
    function ensureCardBox() {
      if (cardBoxEl) return cardBoxEl;
      cardBoxEl = el("div", "agx-page-card");
      cardBoxEl.style.display = "none";
      cardBoxEl.setAttribute("role", "status");
      cardBoxEl.setAttribute("aria-live", "polite");

      var head = el("div", "agx-page-card-head");
      var titleEl = el("strong");
      var dismissBtn = el("button", null, "×");
      dismissBtn.type = "button";
      dismissBtn.setAttribute("aria-label", "Dismiss");
      dismissBtn.addEventListener("click", safe(function () { hideCard(); }));
      head.appendChild(titleEl);
      head.appendChild(dismissBtn);

      var bodyEl = el("p", "agx-page-card-body");

      var ctaBtn = el("button", "agx-page-card-cta");
      ctaBtn.type = "button";
      ctaBtn.addEventListener("click", safe(function () {
        reportOutcomeOnce(currentCardId, "cta", currentCardShownAt);
        runCardCta(currentCardCta);
        hideCard("cta"); // resolved as "cta", not "dismissed" — see file header comment; was: "dismissed by ... the CTA is taken" — see file header comment (already reported above; hideCard's own report is a no-op)
      }));

      var footer = el("div", "agx-message-footer");
      var whyBtn = el("button", "agx-why-toggle", "Why?");
      whyBtn.type = "button";
      whyBtn.setAttribute("aria-expanded", "false");
      var turnOffBtn = el("button", "agx-turnoff", "Turn off");
      turnOffBtn.type = "button";
      turnOffBtn.addEventListener("click", safe(function () { setEnabled(false); }));
      footer.appendChild(whyBtn);
      footer.appendChild(turnOffBtn);

      var whyLine = el("div", "agx-why-line");
      whyLine.style.display = "none";
      whyBtn.addEventListener("click", safe(function () {
        var open = whyLine.style.display !== "none";
        if (open) {
          whyLine.style.display = "none";
          whyBtn.setAttribute("aria-expanded", "false");
        } else {
          whyLine.textContent = computeWhyText();
          whyLine.style.display = "block";
          whyBtn.setAttribute("aria-expanded", "true");
        }
      }));

      cardBoxEl.appendChild(head);
      cardBoxEl.appendChild(bodyEl);
      cardBoxEl.appendChild(ctaBtn);
      cardBoxEl.appendChild(footer);
      cardBoxEl.appendChild(whyLine);
      document.body.appendChild(cardBoxEl);
      cardBoxEl._title = titleEl;
      cardBoxEl._body = bodyEl;
      cardBoxEl._cta = ctaBtn;
      cardBoxEl._whyLine = whyLine;
      cardBoxEl._whyBtn = whyBtn;
      return cardBoxEl;
    }
    // Diffed before write (perf/attribute-thrash defect class): called
    // unconditionally every 250ms while a card is showing, so writing
    // textContent/disabled/display on every tick — even when nothing
    // changed — thrashes layout/a11y-tree for no reason. Mirrored in
    // web/components/AgentWidget.tsx (React already diffs there via state).
    function renderCardCta(box, cta) {
      var nextText, nextDisabled, nextDisplay;
      if (cta && cta.kind === "pick_size" && pickSizeCurrentlySelected(cta.value)) {
        nextText = "Size " + cta.value + " selected ✓";
        nextDisabled = true;
        nextDisplay = "inline-block";
      } else if (cta && cta.kind !== "none" && cta.label) {
        nextText = String(cta.label);
        nextDisabled = false;
        nextDisplay = "inline-block";
      } else {
        nextText = box._cta.textContent;
        nextDisabled = false;
        nextDisplay = "none";
      }
      if (box._cta.textContent !== nextText) box._cta.textContent = nextText;
      if (box._cta.disabled !== nextDisabled) box._cta.disabled = nextDisabled;
      if (box._cta.style.display !== nextDisplay) box._cta.style.display = nextDisplay;
    }
    function renderCard(card, actionId, target) {
      var box = ensureCardBox();
      cancelFade(box);
      box.classList.remove("is-target-occluded");
      currentCardCta = card.cta || null;
      currentCardId = actionId || null;
      currentCardShownAt = Date.now();
      currentCardTarget = target;
      currentCardIssuedPath = pagePath;
      box._title.textContent = card.title || "";
      box._body.textContent = card.body || "";
      box._whyLine.style.display = "none";
      box._whyBtn.setAttribute("aria-expanded", "false");
      renderCardCta(box, card.cta);
      restartCardEntryAnimation(box);
      box.style.display = "flex";
      // Scroll-jail defect class: scroll into view exactly ONCE, here at
      // render time — never inside positionCardNow's 250ms poll or the
      // scroll/resize listener, or a shopper who deliberately scrolls away
      // gets yanked back every tick. Mirrors web/components/AgentWidget.tsx.
      var targetElNode = target ? targetEl(target) : null;
      if (targetElNode && !isInViewport(targetElNode)) {
        targetElNode.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
      }
      positionCardNow();
      if (cardPollTimer) clearInterval(cardPollTimer);
      cardPollTimer = setInterval(safe(positionCardNow), 250);
    }
    // reason: outcome to report, default "dismiss" (× button).
    function hideCard(reason) {
      if (cardBoxEl && cardBoxEl.style.display !== "none") {
        fadeOutBox(cardBoxEl);
        cardBoxEl.classList.remove("is-target-occluded");
        cardBoxEl._whyLine.style.display = "none";
        cardBoxEl._whyBtn.setAttribute("aria-expanded", "false");
      }
      if (currentCardId) {
        reportOutcomeOnce(currentCardId, reason || "dismiss", currentCardShownAt);
        markSuggestionResolved(currentCardId, reason || "dismiss");
      }
      currentCardCta = null;
      currentCardId = null;
      currentCardTarget = null;
      currentCardIssuedPath = null;
      if (cardPollTimer) { clearInterval(cardPollTimer); cardPollTimer = null; }
    }
    // Reposition the card on resize/scroll (rAF-throttled) and on window
    // `load` — bound once here; positionCardNow() no-ops when no card is
    // showing, so this is safe to leave attached at all times.
    (function () {
      var cardRafId = null;
      var repositionCard = safe(function () {
        if (cardRafId != null) return;
        cardRafId = requestAnimationFrame(safe(function () {
          cardRafId = null;
          positionCardNow();
        }));
      });
      window.addEventListener("resize", repositionCard);
      window.addEventListener("scroll", repositionCard, true); // capture: any scrollable ancestor, not just the window
      window.addEventListener("load", repositionCard);
    })();

    // Card-interrupts-typing defect class, render-time guard: previous
    // version applied isTypingTarget() only at ACTION-RECEIPT time (a
    // one-shot setTimeout deferring the reveal by exactly
    // CARD_TYPING_DEFER_MS) — if the shopper kept typing past that fixed
    // window, the timer fired anyway and revealed the card/message while
    // they were still mid-sentence. isActivelyTyping()/syncTypingSuppression
    // below make it a render-time predicate instead: re-evaluated on every
    // keydown in a typing target, on focusout, and on a 250ms poll — the
    // card/message stay hidden (visibility, state kept) for as long as
    // activeElement is a text input/textarea/contenteditable and its last
    // keydown was under CARD_TYPING_DEFER_MS ago; they reappear the instant
    // typing goes idle or blurs. Highlights/spotlights are untouched. Mirrors
    // web/components/AgentWidget.tsx.
    var lastTypingKeydownAt = 0;
    function isActivelyTyping() {
      // Evidence-based, not focus-based: a keystroke/input in a typing field
      // within the window suppresses, whatever activeElement reports (inputs
      // that re-render per keystroke briefly report body). focusout clears.
      return (Date.now() - lastTypingKeydownAt) < CARD_TYPING_DEFER_MS;
    }
    function syncTypingSuppression() {
      var v = isActivelyTyping();
      if (cardBoxEl) cardBoxEl.classList.toggle("is-typing-suppressed", v);
      if (messageBoxEl) messageBoxEl.classList.toggle("is-typing-suppressed", v);
    }
    var onTypingEvidence = safe(function (e) {
      if (isTypingTarget(e.target)) {
        lastTypingKeydownAt = Date.now();
        syncTypingSuppression();
      }
    });
    // keydown AND input: paste, autofill, IME composition and some automation
    // produce input events without per-character keydowns.
    document.addEventListener("keydown", onTypingEvidence, true);
    document.addEventListener("input", onTypingEvidence, true);
    document.addEventListener("focusout", safe(function (e) {
      if (isTypingTarget(e.target)) lastTypingKeydownAt = 0;
      setTimeout(safe(syncTypingSuppression), 0);
    }), true);
    setInterval(safe(syncTypingSuppression), 250);

    // Tiny chip anchored next to the pill while a highlight/spotlight is
    // active — anchoring near the arbitrary host-page target is fragile on
    // an embed (unknown layout/scroll container), so this reuses the pill's
    // corner for both the reference storefront and the embed, per the brief.
    var highlightChipEl = null;
    function ensureHighlightChip() {
      if (highlightChipEl) return highlightChipEl;
      highlightChipEl = el("div", "agx-highlight-chip");
      highlightChipEl.style.display = "none";
      highlightChipEl.setAttribute("role", "status");
      highlightChipEl.setAttribute("aria-live", "polite");

      var row = el("div", "agx-highlight-chip-row");
      var whyBtn = el("button", "agx-why-toggle", "Why?");
      whyBtn.type = "button";
      whyBtn.setAttribute("aria-expanded", "false");
      var closeBtn = el("button", "agx-highlight-dismiss", "×");
      closeBtn.type = "button";
      closeBtn.setAttribute("aria-label", "Dismiss highlight");
      closeBtn.addEventListener("click", safe(function () { clearActiveExecution(); }));
      row.appendChild(whyBtn);
      row.appendChild(closeBtn);

      var whyLine = el("div", "agx-why-line");
      whyLine.style.display = "none";
      whyBtn.addEventListener("click", safe(function () {
        var open = whyLine.style.display !== "none";
        if (open) {
          whyLine.style.display = "none";
          whyBtn.setAttribute("aria-expanded", "false");
        } else {
          whyLine.textContent = computeWhyText();
          whyLine.style.display = "block";
          whyBtn.setAttribute("aria-expanded", "true");
        }
      }));

      highlightChipEl.appendChild(row);
      highlightChipEl.appendChild(whyLine);
      document.body.appendChild(highlightChipEl);
      highlightChipEl._whyLine = whyLine;
      highlightChipEl._whyBtn = whyBtn;
      return highlightChipEl;
    }
    function showHighlightChip() {
      ensureHighlightChip().style.display = "block";
    }
    function hideHighlightChip() {
      if (!highlightChipEl) return;
      highlightChipEl.style.display = "none";
      highlightChipEl._whyLine.style.display = "none";
      highlightChipEl._whyBtn.setAttribute("aria-expanded", "false");
    }

    // A delivered (non-noop) action becomes a permanent tray card, added
    // BEFORE the DOM effect below (so it's captured even if the effect
    // itself no-ops, e.g. target not present on this page) and regardless
    // of state.enabled (the action still arrived over the wire either way —
    // enabled/disabled only gates whether the DOM effect below runs).
    function addSuggestion(a) {
      var t = state.traces[0];
      var isCard = a.action === "card" && a.card;
      var text = (a.action === "message" && a.message) ? String(a.message) : suggestionSentence(a);
      var s = {
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        ts: Date.now(),
        action: a.action,
        target: a.target || null,
        text: text,
        hypothesis: (t && t.hypothesis) || null,
        confidence: t ? t.confidence : null,
        why: (t && t.why) || null
      };
      if (isCard) {
        s.cardTitle = a.card.title;
        s.cta = a.card.cta;
      }
      if (a.id) {
        s.actionId = a.id;
        // Outcome tracking (server/RESEARCH.md "Outcomes" section):
        // register this action's info once, here — the one place
        // guaranteed to run for every non-noop action kind regardless of
        // state.enabled or which live element (if any) ends up displaying
        // it — so reportOutcomeOnce() calls elsewhere only need an id.
        pendingActionInfo[a.id] = {
          action: a.action,
          target: a.target || null,
          ctaKind: isCard && a.card.cta ? a.card.cta.kind : undefined
        };
      }
      state.suggestions.unshift(s);
      if (state.suggestions.length > MAX_SUGGESTIONS) state.suggestions.length = MAX_SUGGESTIONS;
      saveSuggestions(state.suggestions);
      if (!state.assistOpen) state.unseenCount += 1;
      renderTray();
      renderLauncherBadge();
    }

    function applyAction(a) {
      if (ACTIONS.indexOf(a.action) === -1) return;
      if (a.action !== "noop") addSuggestion(a);
      if (!state.enabled) { render(); return; }
      var el = a.target ? targetEl(a.target) : null;
      switch (a.action) {
        case "highlight": {
          if (!el) return;
          // A NEW highlight replacing still-live ones is "ignored" for
          // those (never dismissed/interacted with, just superseded) —
          // mirrors web/components/AgentWidget.tsx's clearActiveEffect
          // call before highlight/spotlight. Also clears any active
          // spotlight so the two effects never stack.
          clearActiveExecution("ignored");
          var cls = a.style === "outline" ? "agx-outline" : "agx-pulse";
          el.classList.add(cls);
          state.lastEffectAt = Date.now();
          var hShownAt = Date.now();
          var hTimer = setTimeout(safe(function () {
            el.classList.remove(cls);
            state.activeHighlights = state.activeHighlights.filter(function (h) { return h.el !== el; });
            // Natural duration_ms expiry — not one of the five tracked
            // outcomes, so nothing reported here (see clearActiveExecution
            // for the reported end conditions); the id stays resolvable
            // later via the tray.
          }), a.duration_ms || 20000);
          state.activeHighlights.push({ el: el, cls: cls, timer: hTimer, actionId: a.id, shownAt: hShownAt });
          break;
        }
        case "spotlight": {
          if (!el) return;
          // Clear any still-live highlight/spotlight first (leaked timer +
          // early un-dim + unreported old action otherwise) — see the
          // highlight case above for the same fix.
          clearActiveExecution("ignored");
          document.body.classList.add("agx-dim");
          el.classList.add("agx-spotlight");
          state.spotlightEl = el;
          state.spotlightActionId = a.id;
          state.spotlightShownAt = Date.now();
          state.lastEffectAt = Date.now();
          state.spotlightTimer = setTimeout(safe(function () {
            document.body.classList.remove("agx-dim");
            el.classList.remove("agx-spotlight");
            if (state.spotlightEl === el) { state.spotlightEl = null; state.spotlightActionId = null; }
            state.spotlightTimer = null;
          }), a.duration_ms || 20000);
          break;
        }
        case "scroll_to": {
          // No lingering on-page affordance (no chip) — outcome resolved
          // right here: "cta" if it actually found and scrolled to its
          // target, "ignored" if the target wasn't on this page. If the
          // agent is off, applyAction already returned above and this
          // branch never runs — the id stays resolvable later via the
          // tray's Show me/Dismiss instead.
          var scrollFound = !!el;
          if (scrollFound) el.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
          reportOutcomeOnce(a.id, scrollFound ? "cta" : "ignored", Date.now());
          break;
        }
        case "message": {
          if (!a.message) return;
          // No auto-expiry (message/card stay until ×, CTA, or a fresh
          // message/card replaces them — see file header comment; duration_ms
          // is still honored above for highlight/spotlight only). A fresh
          // message replacing a still-showing old card/message is "ignored"
          // for the old one (hideCard/hideMessage's own reportOutcomeOnce
          // handles that; a no-op if nothing was showing).
          if (el) el.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
          hideCard("ignored");
          hideMessage("ignored");
          renderMessage(String(a.message), a.id);
          syncTypingSuppression();
          break;
        }
        case "card": {
          if (!a.card) return;
          // No defer-on-receipt here anymore — the typing guard is a
          // render-time predicate (isActivelyTyping/syncTypingSuppression,
          // see the card reposition IIFE above) applied via the
          // is-typing-suppressed class, so the card/message DOM is always
          // set immediately and the render itself decides whether it's
          // visible right now.
          hideMessage("ignored");
          hideCard("ignored");
          // Positioning (anchor-to-target or banner, including the
          // one-time off-screen scrollIntoView) is handled by renderCard
          // below — no separate scroll here.
          renderCard(a.card, a.id, a.target || null);
          syncTypingSuppression();
          break;
        }
        case "noop":
        default:
          break;
      }
    }
    // ----
    // In-page demo player (DEMO.md "No-terminal demo"). GET /demo/fixtures
    // and POST /demo/play/:fixture only exist when the server was started
    // with AGENT_DEBUG=1 — a 404/network error here just means production,
    // and the panel stays clean (no demo row rendered).
    function fetchDemoFixtures() {
      fetch(cfg.httpBase + "/demo/fixtures").then(function (res) {
        return res.ok ? res.json() : null;
      }).then(function (list) {
        if (!list || Object.prototype.toString.call(list) !== "[object Array]" || !list.length) return;
        state.demoFixtures = list;
        state.debugAvailable = true;
        updateDemoUI();
        renderTesterTools();
      }).catch(function () { /* production / no AGENT_DEBUG — render nothing */ });
    }
    // /demo/fixtures alone under-detects AGENT_DEBUG (200 [] outside
    // AGENT_MODE=cached even with AGENT_DEBUG=1 — see server/index.js).
    // Probe GET /sessions?limit=1 as a second signal, per the brief's
    // contract; either succeeding is enough to show the tester tools.
    function probeDebug() {
      fetch(cfg.httpBase + "/sessions?limit=1").then(function (res) {
        if (res.ok) {
          state.debugAvailable = true;
          renderTesterTools();
        }
      }).catch(function () {});
    }
    // Demo row now lives in the assistant panel's Tester tools section (not
    // the dev trace panel) — see buildAssistPanel()/assistEls below.
    function updateDemoUI() {
      if (!assistEls || !assistEls.demoRow) return;
      assistEls.demoButtons.textContent = "";
      state.demoFixtures.forEach(function (fx) {
        var status = (state.demoStatus && state.demoStatus.fixture === fx.name) ? state.demoStatus : null;
        var label = fx.name + (status && status.state === "playing" ? " …" : status && status.state === "done" ? " ✓" : "");
        var btn = el("button", "agx-demo-btn", label);
        btn.type = "button";
        btn.title = fx.description || "";
        if (status && status.state === "playing") btn.disabled = true;
        btn.addEventListener("click", safe(function () { handleDemoClick(fx); }));
        assistEls.demoButtons.appendChild(btn);
      });
      var statusText = "";
      if (state.demoStatus && state.demoStatus.state === "error" && state.demoStatus.message) {
        statusText = state.demoStatus.message;
      } else if (state.demoLine) {
        statusText = state.demoLine;
      }
      assistEls.demoStatusEl.textContent = statusText;
      assistEls.demoRow.style.display = state.demoFixtures.length ? "block" : "none";
    }
    // The embed lives on an arbitrary host page — it must NEVER navigate to
    // fixture.page (that's the reference storefront's own path, meaningless
    // on someone else's site). Instead re-pin the session on the CURRENT
    // page: a full navigation to the same pathname with
    // ?agent_session=<s>&agent_demo=<name> set, so the play happens on
    // whatever page the embed is already on. (web/components/AgentWidget.tsx,
    // the reference storefront, is the one that navigates to fx.page.)
    function handleDemoClick(fx) {
      if (session !== fx.session) {
        var url;
        try { url = new URL(location.href); } catch (err) { return; }
        url.searchParams.set("agent_session", fx.session);
        url.searchParams.set("agent_demo", fx.name);
        location.assign(url.toString());
        return;
      }
      triggerDemoPlay(fx.name);
    }
    var demoWatchdogTimer = null;
    var demoWatchdogFixture = null;
    function clearDemoWatchdog() {
      if (demoWatchdogTimer) { clearTimeout(demoWatchdogTimer); demoWatchdogTimer = null; }
      demoWatchdogFixture = null;
    }
    function triggerDemoPlay(name) {
      state.demoStatus = { fixture: name, state: "playing" };
      clearDemoWatchdog();
      updateDemoUI();
      fetch(cfg.httpBase + "/demo/play/" + encodeURIComponent(name), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Sending the current tab's pinned session keeps the server's 400
        // mismatch guard live end-to-end.
        body: JSON.stringify({ session: session })
      }).then(function (res) {
        if (res.ok) {
          // 202 accepted — playback proceeds async, watch WS for
          // {kind:"demo", state:"end"|"error"}; arm a watchdog in case
          // neither ever arrives.
          return res.json().catch(function () { return null; }).then(function (body) {
            var estimatedMs = (body && typeof body.estimatedMs === "number") ? body.estimatedMs : 0;
            demoWatchdogFixture = name;
            demoWatchdogTimer = setTimeout(safe(function () {
              if (state.demoStatus && state.demoStatus.fixture === name && state.demoStatus.state === "playing") {
                state.demoStatus = { fixture: name, state: "error", message: "no end signal (reload?)" };
                updateDemoUI();
              }
            }), estimatedMs * 3 + 10000);
          });
        }
        return res.json().catch(function () { return {}; }).then(function (body) {
          state.demoStatus = {
            fixture: name, state: "error",
            message: res.status === 409 ? "already playing" : ((body && body.error) || ("HTTP " + res.status))
          };
          updateDemoUI();
        });
      }).catch(function () {
        state.demoStatus = { fixture: name, state: "error", message: "network error" };
        updateDemoUI();
      });
    }
    function onDemo(msg) {
      if (msg.state === "error") {
        if (demoWatchdogFixture === msg.fixture) clearDemoWatchdog();
        state.demoLine = "Demo error: " + msg.fixture;
        state.demoStatus = { fixture: msg.fixture, state: "error", message: msg.error || "playback error" };
        updateDemoUI();
        return;
      }
      state.demoLine = msg.state === "start"
        ? "Demo: " + msg.fixture + " ▶ " + (msg.events != null ? msg.events : "?") + " events"
        : "Demo finished: " + msg.fixture;
      if (msg.state === "end") {
        if (demoWatchdogFixture === msg.fixture) clearDemoWatchdog();
        if (state.demoStatus && state.demoStatus.fixture === msg.fixture && state.demoStatus.state !== "error") {
          state.demoStatus = { fixture: msg.fixture, state: "done" };
        }
        setTimeout(safe(function () {
          if (state.demoStatus && state.demoStatus.fixture === msg.fixture && state.demoStatus.state === "done") {
            state.demoStatus = null;
          }
          updateDemoUI();
        }), 3000);
      }
      updateDemoUI();
    }
    // ----
    var demoAutoPlayed = false;
    function connectWs() {
      var ws;
      try {
        ws = new WebSocket(cfg.wsBase + "?session=" + encodeURIComponent(session));
      } catch (err) { scheduleReconnect(); return; }
      state.ws = ws;
      ws.onopen = safe(function () {
        state.wsBackoff = 1000;
        renderAssistStatus();
        // `?agent_demo=<name>` (DEMO.md's shareable link pattern) auto-plays
        // that fixture 2s after the socket first opens, once per page load
        // (guarded so a reconnect after a dropped connection doesn't replay
        // it) — only when the URL's agent_session still matches this tab's
        // pinned session. Removes agent_demo from the URL afterward
        // (agent_session kept) so a reload doesn't replay.
        if (demoAutoPlayed) return;
        demoAutoPlayed = true;
        var qs;
        try { qs = new URLSearchParams(location.search); } catch (err) { qs = null; }
        var demoName = qs ? qs.get("agent_demo") : null;
        var demoSession = qs ? qs.get("agent_session") : null;
        if (demoName && demoSession && demoSession === session) {
          setTimeout(safe(function () {
            triggerDemoPlay(demoName);
            try {
              var url = new URL(location.href);
              url.searchParams.delete("agent_demo");
              history.replaceState({}, "", url.pathname + url.search + url.hash);
            } catch (err) { /* noop */ }
          }), 2000);
        }
      });
      ws.onmessage = safe(function (e) {
        var msg;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        if (msg.kind === "trace") { onTrace(msg); return; }
        if (msg.kind === "metrics") { onMetrics(msg); return; }
        if (msg.kind === "demo") { onDemo(msg); return; }
        if (msg.kind === "action") { applyAction(msg); return; }
        // {kind:"replay"} isn't part of the fixed contract — harmless to
        // ignore (nothing past this point matches it, same as any other
        // unrecognized kind); explicit branch for clarity per the brief.
        if (msg.kind === "replay") return;
      });
      ws.onclose = safe(function () { if (!state.wsClosed) { renderAssistStatus(); scheduleReconnect(); } });
      ws.onerror = safe(function () { try { ws.close(); } catch (err) {} });
    }
    function scheduleReconnect() {
      var delay = state.wsBackoff;
      state.wsBackoff = Math.min(30000, state.wsBackoff * 2);
      setTimeout(safe(connectWs), delay);
    }
    connectWs();
    // ----
    // Session id precedence (demo pinning, see DEMO.md): URL query
    // `?agent_session=<id>` → script tag `data-session="<id>"` → stored id →
    // freshly minted random id. A URL-pinned id is also written to
    // sessionStorage so it survives client-side navigation on host pages that
    // don't reload the script tag between route changes. Validated against
    // SESSION_ID_RE (top-level constant, see its declaration comment) — an
    // invalid value from either source is ignored, falling through to the
    // next precedence tier.
    // clearPerSessionStorage(): mirrors web/lib/agentSession.ts's own copy
    // of this same guard (that file's top comment has the full rationale —
    // this embed can't import it, being a standalone <script>). Every
    // sessionStorage key scoped to the shopper IDENTITY (not the tab) gets
    // wiped whenever the resolved session id CHANGES, so a tab re-pinned to
    // a different identity via `?agent_session=<new id>` never inherits the
    // previous identity's suggestions tray. `agent_embed_enabled` is
    // deliberately NOT here — a per-tab UI preference, unaffected by which
    // identity is active.
    function clearPerSessionStorage() {
      var keys = [SUGGESTIONS_KEY, SUGGESTIONS_SEEN_AT_KEY];
      for (var i = 0; i < keys.length; i++) {
        try { sessionStorage.removeItem(keys[i]); } catch (err) {}
      }
    }
    function getSessionId() {
      var stored;
      try { stored = sessionStorage.getItem("agent_embed_session"); } catch (err) { stored = null; }

      var fromUrl = null;
      try {
        fromUrl = new URLSearchParams(location.search).get("agent_session");
      } catch (err) { fromUrl = null; }
      if (fromUrl && SESSION_ID_RE.test(fromUrl)) {
        if (fromUrl !== stored) clearPerSessionStorage();
        try { sessionStorage.setItem("agent_embed_session", fromUrl); } catch (err) {}
        return fromUrl;
      }

      var fromAttr = scriptEl && scriptEl.getAttribute("data-session");
      if (fromAttr && SESSION_ID_RE.test(fromAttr)) {
        if (fromAttr !== stored) clearPerSessionStorage();
        try { sessionStorage.setItem("agent_embed_session", fromAttr); } catch (err) {}
        return fromAttr;
      }

      var id = stored;
      if (id && !SESSION_ID_RE.test(id)) id = null; // stale/corrupt stored value
      if (!id) {
        id = "s_" + Math.random().toString(36).slice(2, 10);
        try { sessionStorage.setItem("agent_embed_session", id); } catch (err) {}
      }
      return id;
    }
    function getEnabled() {
      try {
        var v = sessionStorage.getItem("agent_embed_enabled");
        return v === null ? true : v === "1";
      } catch (err) { return true; }
    }
    function setEnabled(v) {
      state.enabled = !!v;
      try { sessionStorage.setItem("agent_embed_enabled", state.enabled ? "1" : "0"); } catch (err) {}
      // Turning off also removes the current bubble and any active
      // highlight — same "Turn off" path as the bubble footer's link
      // (window.AgentEmbed.setEnabled(false)), not just the pill flipping.
      // Outcome "turn_off" (server/RESEARCH.md "Outcomes" section) either
      // way — this embed's generic Controls pill and the card/bubble's own
      // "Turn off" link both funnel through this one function, unlike the
      // React widget where they're separate; reporting turn_off uniformly
      // for both is the more accurate category fix (the agent WAS turned
      // off either way) rather than special-casing by caller.
      if (!state.enabled) { clearActiveExecution("turn_off"); hideMessage("turn_off"); hideCard("turn_off"); }
      render();
    }

    // panelEls: declared WITHOUT an initializer (bare `var name;`) on
    // purpose. `var name = null;` re-executes its assignment every time
    // control flow reaches this statement during boot()'s normal top-to-
    // bottom run — if that statement sits (textually) after the code that
    // already populated the variable, it silently clobbers the real value
    // back to null right after assignment, and nothing ever sets it again.
    // That was the exact root cause of D2 (pill label frozen after the very
    // first render, back when a standalone on/off pill existed here): a
    // `var name = null;` used to reset an element reference set moments
    // earlier in the same synchronous pass, so every later render() call
    // hit `if (!name) return;` and no-opped forever. A bare `var panelEls;`
    // is a declaration-only no-op if the name is already bound — it does
    // NOT reset an existing value.
    // ----
    // Single injected-element factory. EVERY agent-created DOM node must go
    // through this (rather than document.createElement directly) so it
    // always inherits data-agx-ui — the one flag both discoverTargets() and
    // extractFactsFrom() use (via isOwnUI()) to skip the agent's own UI.
    // This is the category fix for D1: any future injected element that
    // uses el() automatically stays out of target discovery and facts
    // extraction, with no per-call-site opt-in required.
    function el(tag, cls, text) {
      var n = document.createElement(tag);
      n.setAttribute("data-agx-ui", "");
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }

    var panelEls;
    function buildPanel() {
      if (!cfg.panel) return null;
      var root = el("aside", "agx-panel");
      var head = el("div", "agx-panel-head");
      var toggle = el("button", "agx-panel-toggle", "−");
      toggle.type = "button";
      head.appendChild(el("span", null, "Agent"));
      head.appendChild(el("span", "agx-panel-session", session));
      head.appendChild(toggle);
      var metricsRow = el("div", "agx-panel-metrics");
      var suppressed = el("div", "agx-panel-suppressed", "Agent is off — tracking only.");
      suppressed.style.display = "none";
      var thinkingRow = el("div", "agx-thinking");
      thinkingRow.style.display = "none";
      // Demo row lives in the assistant panel's Tester tools section now
      // (buildAssistPanel() below), not this dev trace panel.
      var body = el("div", "agx-panel-body");
      var rules = el("div", "agx-panel-rules",
        "Watches views/dwell/scroll/clicks. Acts at most once per 30s, never twice on the same thing.");
      [head, metricsRow, suppressed, thinkingRow, body, rules].forEach(function (n) { root.appendChild(n); });
      document.body.appendChild(root);

      // Collapsed by default — this is a debug/proof-of-work view, not the
      // shopper-facing help surface (the assistant panel is), and must not
      // visually compete with the always-on launcher/panel in the same
      // corner of the screen.
      root.classList.add("is-collapsed");
      toggle.textContent = "+";

      toggle.addEventListener("click", safe(function () {
        root.classList.toggle("is-collapsed");
        toggle.textContent = root.classList.contains("is-collapsed") ? "+" : "−";
      }));

      return {
        root: root, metricsRow: metricsRow, body: body, suppressed: suppressed,
        thinkingRow: thinkingRow
      };
    }

    // ---- persistent assistant panel (launcher + tray) ------------------------
    // Always built (unlike the dev trace panel, which is gated behind
    // cfg.panel/data-panel="true") — this is the shopper-facing help surface
    // the brief asks for, present on every embed regardless of debug config.
    var launcherEl;
    var launcherBadgeEl;
    function buildLauncher() {
      launcherEl = el("button", "agx-launcher");
      launcherEl.type = "button";
      launcherEl.setAttribute("aria-haspopup", "dialog");
      launcherEl.setAttribute("aria-expanded", "false");
      launcherEl.setAttribute("aria-label", "Open store assistant");
      var icon = el("span", null, "💬"); // 💬
      icon.setAttribute("aria-hidden", "true");
      launcherBadgeEl = el("span", "agx-launcher-badge");
      launcherBadgeEl.style.display = "none";
      launcherEl.appendChild(icon);
      launcherEl.appendChild(launcherBadgeEl);
      launcherEl.addEventListener("click", safe(function () { toggleAssist(); }));
      document.body.appendChild(launcherEl);
    }

    function assistStatusText() {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return "offline";
      if (!state.enabled) return "paused";
      var idleMs = Date.now() - (state.lastTraceAt || 0);
      if (idleMs > 3000) return "thinking · " + Math.floor(idleMs / 1000) + "s";
      return "watching";
    }

    var assistEls;
    function buildAssistPanel() {
      var root = el("aside", "agx-assist");
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-label", "Store assistant");
      root.style.display = "none";

      var head = el("div", "agx-assist-head");
      head.appendChild(el("span", "agx-assist-title", "Store assistant"));
      var statusEl = el("span", "agx-assist-status", "watching");
      head.appendChild(statusEl);
      var closeBtn = el("button", "agx-assist-close", "×");
      closeBtn.type = "button";
      closeBtn.setAttribute("aria-label", "Close store assistant");
      closeBtn.addEventListener("click", safe(function () { closeAssist(); }));
      head.appendChild(closeBtn);

      var body = el("div", "agx-assist-body");

      var traySection = el("section", "agx-assist-section");
      traySection.appendChild(el("h3", "agx-assist-heading", "Suggestions"));
      var tray = el("div", "agx-assist-tray");
      tray.setAttribute("aria-live", "polite");
      traySection.appendChild(tray);

      var noticedSection = el("section", "agx-assist-section");
      noticedSection.appendChild(el("h3", "agx-assist-heading", "What I noticed"));
      var noticed = el("div", "agx-assist-noticed");
      noticedSection.appendChild(noticed);

      var controlsSection = el("section", "agx-assist-section");
      controlsSection.appendChild(el("h3", "agx-assist-heading", "Controls"));
      var controls = el("div", "agx-assist-controls");
      var toggleBtn = el("button", "agx-toggle-btn");
      toggleBtn.type = "button";
      toggleBtn.addEventListener("click", safe(function () { setEnabled(!state.enabled); }));
      var clearBtn = el("button", "agx-clear-btn", "Clear suggestions");
      clearBtn.type = "button";
      clearBtn.addEventListener("click", safe(function () { clearAllSuggestions(); }));
      controls.appendChild(toggleBtn);
      controls.appendChild(clearBtn);
      controlsSection.appendChild(controls);

      var testerSection = el("section", "agx-assist-section agx-assist-tester");
      testerSection.style.display = "none"; // shown once state.debugAvailable
      testerSection.appendChild(el("h3", "agx-assist-heading", "Tester tools"));
      var demoRow = el("div", "agx-demo");
      demoRow.style.display = "none";
      var demoLabel = el("div", "agx-demo-label", "Demo");
      var demoButtons = el("div", "agx-demo-buttons");
      var demoStatusEl = el("div", "agx-demo-status");
      [demoLabel, demoButtons, demoStatusEl].forEach(function (n) { demoRow.appendChild(n); });
      testerSection.appendChild(demoRow);

      var decideRow = el("div", "agx-tester-row");
      var decideBtn = el("button", null, "Decide now");
      decideBtn.type = "button";
      decideBtn.addEventListener("click", safe(function () { decideNow(); }));
      var decideResult = el("span", "agx-tester-result");
      decideRow.appendChild(decideBtn);
      decideRow.appendChild(decideResult);
      testerSection.appendChild(decideRow);

      var resetRow = el("div", "agx-tester-row");
      var resetBtn = el("button", null, "Reset session");
      resetBtn.type = "button";
      resetBtn.addEventListener("click", safe(function () { resetSession(); }));
      resetRow.appendChild(resetBtn);
      testerSection.appendChild(resetRow);

      // The embed lives on an arbitrary host page — a real link to
      // /sessions/<id> would point at THIS host, not the reference
      // storefront's research page, so it's shown as plain text instead
      // (per the brief: "embed shows the URL text").
      var researchRow = el("div", "agx-tester-row", "Research page: /sessions/" + session);
      testerSection.appendChild(researchRow);

      body.appendChild(traySection);
      body.appendChild(noticedSection);
      body.appendChild(controlsSection);
      body.appendChild(testerSection);

      root.appendChild(head);
      root.appendChild(body);
      document.body.appendChild(root);

      return {
        root: root, statusEl: statusEl, tray: tray, noticed: noticed,
        toggleBtn: toggleBtn, clearBtn: clearBtn,
        testerSection: testerSection, demoRow: demoRow, demoButtons: demoButtons, demoStatusEl: demoStatusEl,
        decideBtn: decideBtn, decideResult: decideResult, resetBtn: resetBtn
      };
    }

    function renderLauncherBadge() {
      if (!launcherBadgeEl) return;
      if (state.unseenCount > 0) {
        launcherBadgeEl.textContent = state.unseenCount > 9 ? "9+" : String(state.unseenCount);
        launcherBadgeEl.style.display = "block";
        launcherBadgeEl.setAttribute("aria-label", state.unseenCount + " new suggestion" + (state.unseenCount === 1 ? "" : "s"));
      } else {
        launcherBadgeEl.style.display = "none";
      }
    }

    function renderAssistStatus() {
      if (assistEls) assistEls.statusEl.textContent = assistStatusText();
    }

    function renderAssistControls() {
      if (!assistEls) return;
      assistEls.toggleBtn.textContent = "Agent " + (state.enabled ? "on" : "off");
      assistEls.toggleBtn.setAttribute("aria-pressed", String(state.enabled));
      assistEls.clearBtn.disabled = state.suggestions.length === 0;
    }

    function renderTesterTools() {
      if (!assistEls) return;
      assistEls.testerSection.style.display = state.debugAvailable ? "block" : "none";
    }

    function suggestionWhyText(s) {
      var basis = s.hypothesis || s.why || "No reasoning recorded.";
      var pct = (s.confidence != null) ? (" · " + Math.round(s.confidence * 100) + "% sure") : "";
      return basis + pct;
    }

    function renderTray() {
      if (!assistEls) return;
      assistEls.tray.textContent = "";
      if (!state.suggestions.length) {
        assistEls.tray.appendChild(el("p", "agx-assist-empty", "Nothing yet — I'll drop suggestions here as I notice things."));
        return;
      }
      var now = Date.now();
      state.suggestions.forEach(function (s) {
        // s.resolved (tray/badge-desync fix, finding B): this suggestion's
        // live slot (card/message/highlight) already ended — its Show
        // me/CTA controls are inert instead of silently no-op'ing.
        var card = el("div", "agx-card" + (s.resolved ? " is-resolved" : ""));
        if (s.cardTitle) card.appendChild(el("div", "agx-card-title", s.cardTitle));
        card.appendChild(el("div", "agx-card-text", s.text));
        var timeText = timeAgo(s.ts, now) + (s.resolved ? " · " + (s.resolved === "cta" ? "done" : "dismissed") : "");
        card.appendChild(el("div", "agx-card-time", timeText));
        var actions = el("div", "agx-card-actions");
        if (!s.resolved && s.cta && s.cta.kind !== "none" && s.cta.label) {
          var ctaBtn = el("button", null, String(s.cta.label));
          ctaBtn.type = "button";
          ctaBtn.addEventListener("click", safe(function () {
            reportOutcomeOnce(s.actionId, "cta", s.ts);
            markSuggestionResolved(s.actionId, "cta");
            runCardCta(s.cta);
          }));
          actions.appendChild(ctaBtn);
        }
        if (!s.resolved) {
          var showBtn = el("button", null, "Show me");
          showBtn.type = "button";
          showBtn.addEventListener("click", safe(function () { showSuggestion(s); }));
          actions.appendChild(showBtn);
        }
        var whyBtn = el("button", "agx-why-toggle", "Why?");
        whyBtn.type = "button";
        whyBtn.setAttribute("aria-expanded", "false");
        var dismissBtn = el("button", null, "Dismiss");
        dismissBtn.type = "button";
        dismissBtn.setAttribute("aria-label", "Dismiss suggestion");
        dismissBtn.addEventListener("click", safe(function () { dismissSuggestion(s); }));
        actions.appendChild(whyBtn);
        actions.appendChild(dismissBtn);
        card.appendChild(actions);
        var whyLine = el("div", "agx-why-line", suggestionWhyText(s));
        whyLine.style.display = "none";
        whyBtn.addEventListener("click", safe(function () {
          var open = whyLine.style.display !== "none";
          whyLine.style.display = open ? "none" : "block";
          whyBtn.setAttribute("aria-expanded", open ? "false" : "true");
        }));
        card.appendChild(whyLine);
        assistEls.tray.appendChild(card);
      });
    }

    function renderNoticed() {
      if (!assistEls) return;
      assistEls.noticed.textContent = "";
      var t = state.traces[0];
      if (!t) {
        assistEls.noticed.appendChild(el("p", "agx-assist-empty", "Watching. Nothing decided yet."));
        return;
      }
      var noticedLines = buildNoticedLines(t.signals);
      if (noticedLines.length) {
        var ul = el("ul", "agx-noticed-signals");
        noticedLines.forEach(function (line) { ul.appendChild(el("li", null, line)); });
        assistEls.noticed.appendChild(ul);
      } else {
        assistEls.noticed.appendChild(el("p", "agx-noticed-signals-empty", "(no signals)"));
      }
      assistEls.noticed.appendChild(el("p", "agx-noticed-decision", noticedPrimaryText(t)));
      if (t.hypothesis) {
        var whyBtn2 = el("button", "agx-why-toggle agx-noticed-why-toggle", state.noticedWhyOpen ? "Hide why" : "Why?");
        whyBtn2.type = "button";
        whyBtn2.setAttribute("aria-expanded", state.noticedWhyOpen ? "true" : "false");
        whyBtn2.addEventListener("click", safe(function () {
          state.noticedWhyOpen = !state.noticedWhyOpen;
          renderNoticed();
        }));
        assistEls.noticed.appendChild(whyBtn2);
        if (state.noticedWhyOpen) {
          assistEls.noticed.appendChild(el("p", "agx-noticed-hypothesis", t.hypothesis));
        }
      }
    }

    // "Show me" — re-applies an OLD suggestion's effect: scroll target into
    // view + a short 5s pulse. Independent of applyAction()'s
    // activeHighlights/spotlight bookkeeping (that belongs to the CURRENT
    // live decision, not a historical one being replayed from the tray).
    // Outcome (server/RESEARCH.md "Outcomes" section): "cta" — the shopper
    // engaged with an old suggestion again — same bucket as a card's own
    // CTA button, only if no outcome was reported yet for that id
    // (reportOutcomeOnce is idempotent).
    function showSuggestion(s) {
      reportOutcomeOnce(s.actionId, "cta", s.ts);
      var targetElNode = s.target ? targetEl(s.target) : null;
      if (!targetElNode) return;
      targetElNode.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
      targetElNode.classList.add("agx-pulse");
      setTimeout(safe(function () { targetElNode.classList.remove("agx-pulse"); }), SHOW_ME_PULSE_MS);
    }

    // Tray/badge-desync defect class: these used to mutate state.suggestions
    // without ever recomputing state.unseenCount, so the launcher badge kept
    // showing a stale count over an empty (or partially-emptied) tray.
    function dismissSuggestion(s) {
      reportOutcomeOnce(s.actionId, "dismiss", s.ts);
      state.suggestions = state.suggestions.filter(function (x) { return x.id !== s.id; });
      saveSuggestions(state.suggestions);
      state.unseenCount = countUnseen(state.suggestions, loadSeenAt());
      renderTray();
      renderAssistControls();
      renderLauncherBadge();
    }

    function clearAllSuggestions() {
      state.suggestions.forEach(function (s) { reportOutcomeOnce(s.actionId, "dismiss", s.ts); });
      state.suggestions = [];
      saveSuggestions(state.suggestions);
      state.unseenCount = 0;
      renderTray();
      renderAssistControls();
      renderLauncherBadge();
    }

    // markSuggestionResolved(actionId, outcome) — tray/badge-desync defect
    // class fix (finding B): called alongside every reportOutcomeOnce() for
    // a live-slot end condition (highlight/spotlight clear, card dismiss/
    // CTA, message dismiss), so the matching tray entry (same actionId)
    // stops looking live — Show me/CTA go inert (see renderTray) and it
    // drops out of unseenCount. Idempotent and a no-op if no tray entry
    // exists yet for this id. Mirrors web/components/AgentWidget.tsx.
    function markSuggestionResolved(actionId, outcome) {
      if (!actionId) return;
      var changed = false;
      state.suggestions.forEach(function (s) {
        if (s.actionId === actionId && !s.resolved) {
          s.resolved = outcome;
          changed = true;
        }
      });
      if (!changed) return;
      saveSuggestions(state.suggestions);
      state.unseenCount = countUnseen(state.suggestions, loadSeenAt());
      renderTray();
      renderLauncherBadge();
    }

    var assistKeydownHandler = null;
    function openAssist() {
      state.assistOpen = true;
      state.unseenCount = 0;
      saveSeenAt(Date.now());
      renderLauncherBadge();
      if (assistEls) assistEls.root.style.display = "flex";
      if (launcherEl) launcherEl.setAttribute("aria-expanded", "true");
      renderAssistStatus();
      renderAssistControls();
      renderTray();
      renderNoticed();
      assistKeydownHandler = safe(function (e) {
        if (e.key === "Escape") closeAssist();
      });
      document.addEventListener("keydown", assistKeydownHandler);
    }
    function closeAssist() {
      state.assistOpen = false;
      if (assistEls) assistEls.root.style.display = "none";
      if (launcherEl) launcherEl.setAttribute("aria-expanded", "false");
      if (assistKeydownHandler) {
        document.removeEventListener("keydown", assistKeydownHandler);
        assistKeydownHandler = null;
      }
      if (launcherEl) launcherEl.focus();
    }
    function toggleAssist() {
      if (state.assistOpen) closeAssist(); else openAssist();
    }

    /** Tester tools — "Decide now": POST /session/<id>/decide (200
     * {action, trace, ms} | 409 in-flight/cached-mode | 404 not debug). */
    function decideNow() {
      if (!assistEls || state.decideBusy) return;
      state.decideBusy = true;
      assistEls.decideBtn.disabled = true;
      assistEls.decideBtn.textContent = "Deciding…";
      assistEls.decideResult.textContent = "";
      fetch(cfg.httpBase + "/session/" + encodeURIComponent(session) + "/decide", { method: "POST" })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            if (res.ok) {
              var action = body.action || {};
              var ms = (typeof body.ms === "number") ? (body.ms / 1000).toFixed(1) : "?";
              var decided = action.action ? (action.action === "noop" ? "noop" : [action.action, action.target].filter(Boolean).join(" ")) : "?";
              assistEls.decideResult.textContent = "decided: " + decided + ", " + ms + "s";
            } else {
              assistEls.decideResult.textContent = body.error || ("HTTP " + res.status);
            }
          });
        })
        .catch(function () { assistEls.decideResult.textContent = "network error"; })
        .then(function () {
          state.decideBusy = false;
          assistEls.decideBtn.disabled = false;
          assistEls.decideBtn.textContent = "Decide now";
        });
    }

    /** Tester tools — "Reset session": DELETE /session/<id>, then reload so
     * every piece of client state starts fresh against the server's
     * now-empty session record. */
    function resetSession() {
      if (!assistEls || state.resetBusy) return;
      state.resetBusy = true;
      assistEls.resetBtn.disabled = true;
      assistEls.resetBtn.textContent = "Resetting…";
      fetch(cfg.httpBase + "/session/" + encodeURIComponent(session), { method: "DELETE" })
        .then(function () { location.reload(); })
        .catch(function () {
          state.resetBusy = false;
          assistEls.resetBtn.disabled = false;
          assistEls.resetBtn.textContent = "Reset session";
        });
    }

    buildLauncher();
    assistEls = buildAssistPanel();
    renderLauncherBadge();
    renderAssistControls();
    renderTray();
    renderNoticed();
    fetchDemoFixtures();
    probeDebug();

    panelEls = ui;
    render(); // sync initial pill/panel state now that both are mounted

    // Single source of truth for pill + panel "on/off" presentation. Always
    // reads state.enabled fresh — never call anything else to reflect
    // enabled/disabled, so pill and panel can never drift from each other
    // or from state (the D2 defect class).
    function render() {
      if (panelEls) {
        panelEls.suppressed.style.display = state.enabled ? "none" : "block";
      }
      renderAssistControls();
      renderAssistStatus();
    }

    function onMetrics(msg) {
      state.metrics = msg;
      if (!panelEls) return;
      var parts = [];
      Object.keys(msg).forEach(function (k) {
        if (k === "kind") return;
        parts.push(k + ": " + msg[k]);
      });
      panelEls.metricsRow.textContent = parts.join(" · ");
    }

    function updateThinking() {
      renderAssistStatus();
      if (!panelEls || !panelEls.thinkingRow) return;
      var open = !!(state.ws && state.ws.readyState === WebSocket.OPEN);
      var idleMs = Date.now() - (state.lastTraceAt || 0);
      if (open && idleMs > 3000) {
        panelEls.thinkingRow.textContent = "thinking · " + Math.floor(idleMs / 1000) + "s";
        panelEls.thinkingRow.style.display = "block";
      } else {
        panelEls.thinkingRow.style.display = "none";
      }
    }
    setInterval(safe(updateThinking), 1000);

    function onTrace(t) {
      state.lastTraceAt = Date.now();
      updateThinking();
      state.traces.unshift(t);
      state.traces = state.traces.slice(0, 30);
      state.noticedWhyOpen = false; // a new decision landed — collapse the old one's expanded hypothesis
      renderNoticed();
      if (!panelEls) return;

      // Collapse consecutive noops into "stayed quiet x N".
      var body = panelEls.body;
      body.textContent = "";
      var i = 0;
      while (i < state.traces.length) {
        var row = state.traces[i];
        if (row.decision === "noop") {
          var n = 0;
          while (i < state.traces.length && state.traces[i].decision === "noop") { n++; i++; }
          body.appendChild(el("div", "agx-row is-noop", "stayed quiet ×" + n));
        } else {
          var rowEl = el("div", "agx-row is-act");
          rowEl.appendChild(el("div", "agx-row-decision", row.decision + "  " + Math.round((row.confidence || 0) * 100) + "%"));
          rowEl.appendChild(el("div", "agx-row-why", row.why || ""));
          body.appendChild(rowEl);
          i++;
        }
      }
    }
    // ----
    function injectStyles() {
      var css = "" +
        // Highlight-under-modal defect class: a host page's own modal (any
        // z-index — this is a drop-in embed for an unknown host) can sit
        // above a plain outline-only highlight with no stacking context of
        // its own. position:relative + a z-index alongside .agx-spotlight's
        // fixes it. Mirrored in web/app/globals.css's .agent-pulse/.agent-outline.
        ".agx-pulse{position:relative;z-index:2147483001;outline:2px solid #b5321e !important;outline-offset:3px;animation:agx-pulse 1.2s ease-in-out infinite !important;}" +
        "@keyframes agx-pulse{0%,100%{box-shadow:0 0 0 0 rgba(181,50,30,.35);}50%{box-shadow:0 0 0 10px rgba(181,50,30,0);}}" +
        ".agx-outline{position:relative;z-index:2147483001;outline:2px solid #b5321e !important;outline-offset:3px;}" +
        "body.agx-dim::after{content:'';position:fixed;inset:0;background:rgba(20,20,20,.5);z-index:2147483000;pointer-events:none;}" +
        ".agx-spotlight{position:relative;z-index:2147483001;box-shadow:0 0 0 12px #fff;border-radius:4px;}" +
        "@media (prefers-reduced-motion: reduce){.agx-pulse{animation:none;}}" +
        ".agx-message{position:fixed;left:24px;bottom:24px;z-index:2147483002;max-width:340px;background:#fff;border-left:3px solid #b5321e;padding:14px 16px;box-shadow:0 8px 30px rgba(0,0,0,.18);border-radius:3px;display:flex;gap:12px;align-items:flex-start;font:14px/1.4 system-ui,sans-serif;color:#1d1a17;}" +
        ".agx-message button{background:none;border:0;color:#6f6a63;font-size:18px;line-height:1;padding:0;cursor:pointer;}" +
        /* Founder rule 2026-09-11: the card appears AT the thing the shopper
         * is looking at, not a fixed corner — .agx-page-card carries no
         * position of its own; .is-anchored (position:absolute, document
         * coordinates, top/left set inline by positionCardNow()) or
         * .is-banner (position:fixed, top of viewport) is added at render
         * time. Mirrors web/app/globals.css's .agent-page-card. */
        ".agx-page-card{z-index:2147483002;max-width:360px;background:#fff;border:1px solid #b5321e;padding:14px 16px;box-shadow:0 8px 30px rgba(0,0,0,.18);border-radius:12px;display:flex;flex-direction:column;font:15px/1.4 system-ui,sans-serif;color:#1d1a17;animation:agx-card-in 160ms ease-out;}" +
        ".agx-page-card.is-anchored{position:absolute;}" +
        ".agx-page-card.is-banner{position:fixed;top:72px;left:50%;transform:translateX(-50%);}" +
        ".agx-page-card.is-anchored.caret-top::before,.agx-page-card.is-anchored.caret-bottom::before{content:'';position:absolute;left:var(--agx-caret-left,24px);width:10px;height:10px;background:#fff;border:1px solid #b5321e;transform:translateX(-50%) rotate(45deg);}" +
        ".agx-page-card.is-anchored.caret-top::before{top:-6px;border-right:0;border-bottom:0;}" +
        ".agx-page-card.is-anchored.caret-bottom::before{bottom:-6px;border-left:0;border-top:0;}" +
        "@keyframes agx-card-in{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}" +
        "@media (prefers-reduced-motion: reduce){.agx-page-card{animation:none;}}" +
        // Exit-fade defect class: card/message used to vanish with a hard
        // display:none, no transition. .is-exiting plays a short fade-out
        // (see hideCard/hideMessage's fadeOutBox, which keeps the node
        // mounted ~120ms to let this play) — the JS side already skips this
        // class entirely under prefers-reduced-motion; the @media guard
        // below is belt-and-braces. Mirrored in web/app/globals.css.
        ".agx-page-card.is-exiting,.agx-message.is-exiting{animation:agx-box-out 120ms ease-in forwards;}" +
        "@keyframes agx-box-out{from{opacity:1;}to{opacity:0;}}" +
        "@media (prefers-reduced-motion: reduce){.agx-page-card.is-exiting,.agx-message.is-exiting{animation:none;}}" +
        // Card-over-modal occlusion defect class (finding A): hide (not
        // remove) the card while a host-page overlay covers its target —
        // see isTargetOccluded()/positionCardNow() below. visibility, not
        // display:none, so position math and the poll keep running.
        ".agx-page-card.is-target-occluded{visibility:hidden;}" +
        // Card-interrupts-typing defect class: render-time guard — hide
        // (not remove) the card/message while the shopper is actively
        // typing elsewhere (see isActivelyTyping()/syncTypingSuppression
        // above). Same visibility-not-display technique as
        // is-target-occluded, so it reappears the instant typing goes idle
        // or blurs. Mirrored in web/app/globals.css.
        ".agx-page-card.is-typing-suppressed,.agx-message.is-typing-suppressed{visibility:hidden;}" +
        ".agx-page-card-head{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;}" +
        ".agx-page-card-head strong{font-size:15px;font-weight:600;}" +
        ".agx-page-card-head button{background:none;border:0;color:#6f6a63;font-size:20px;line-height:1;padding:0;cursor:pointer;}" +
        ".agx-page-card-body{margin:8px 0 12px;font-size:14px;line-height:1.4;}" +
        ".agx-page-card-cta{align-self:flex-start;background:#1d1a17;color:#fbf9f5;border:0;border-radius:4px;padding:8px 14px;font-size:13.5px;cursor:pointer;margin-bottom:4px;}" +
        ".agx-page-card-cta:disabled{opacity:.75;cursor:default;}" +
        /* Mobile: banner mode always, full width minus 16px margins — beats
         * whatever positionCardNow() computed, same as globals.css's rule. */
        "@media (max-width:480px){.agx-page-card,.agx-page-card.is-banner,.agx-page-card.is-anchored{position:fixed !important;top:72px;left:8px;right:8px;bottom:auto;transform:none;max-width:none;width:auto;}.agx-page-card.is-anchored::before{display:none;}}" +
        ".agx-panel{position:fixed;right:0;top:0;bottom:0;width:280px;z-index:2147483002;background:#1d1a17;color:#e9e4dc;font:11.5px/1.4 ui-monospace,Menlo,monospace;padding:12px;overflow-y:auto;box-sizing:border-box;}" +
        ".agx-panel.is-collapsed{width:36px;overflow:hidden;padding:12px 6px;}" +
        ".agx-panel.is-collapsed .agx-panel-metrics,.agx-panel.is-collapsed .agx-panel-body,.agx-panel.is-collapsed .agx-panel-rules,.agx-panel.is-collapsed .agx-panel-session,.agx-panel.is-collapsed .agx-demo{display:none;}" +
        ".agx-panel-head{display:flex;justify-content:space-between;align-items:center;gap:6px;color:#9c948a;margin-bottom:8px;}" +
        ".agx-panel-toggle{background:none;border:1px solid #4a453f;color:#e9e4dc;border-radius:3px;cursor:pointer;padding:0 6px;}" +
        ".agx-panel-metrics{color:#9c948a;margin-bottom:8px;word-break:break-word;}" +
        ".agx-panel-suppressed{color:#e9b17a;margin-bottom:8px;}" +
        ".agx-demo{margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,.08);}" +
        ".agx-demo-label{color:#9c948a;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;}" +
        ".agx-demo-buttons{display:flex;flex-wrap:wrap;gap:6px;}" +
        ".agx-demo-btn{background:rgba(255,255,255,.06);color:#e9e4dc;border:1px solid rgba(255,255,255,.12);border-radius:4px;padding:4px 8px;font:inherit;font-size:11px;cursor:pointer;}" +
        ".agx-demo-btn:disabled{opacity:.6;cursor:default;}" +
        ".agx-demo-status{color:#9c948a;font-size:11px;margin-top:6px;}" +
        ".agx-row{padding:6px 0;border-top:1px solid rgba(255,255,255,.08);}" +
        ".agx-row.is-act .agx-row-decision{color:#ff8a70;}" +
        ".agx-row.is-noop{color:#9c948a;}" +
        ".agx-row-why{color:#cfc8be;margin-top:2px;}" +
        ".agx-panel-rules{color:#6f6a63;margin-top:10px;border-top:1px solid rgba(255,255,255,.08);padding-top:8px;}" +
        ".agx-thinking{color:#e9b17a;margin-bottom:8px;font-style:italic;}" +
        // ---- persistent launcher + assistant panel ------------------------
        ".agx-launcher{position:fixed;right:20px;bottom:20px;z-index:2147483004;width:52px;height:52px;border-radius:50%;border:0;background:#1d1a17;color:#fbf9f5;font-size:22px;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer;}" +
        ".agx-launcher-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:999px;background:#b5321e;color:#fff;font-size:11px;line-height:18px;padding:0 4px;font-weight:600;font-family:system-ui,sans-serif;}" +
        ".agx-assist{position:fixed;right:20px;bottom:84px;z-index:2147483003;width:min(340px,calc(100vw - 32px));max-height:min(70vh,560px);background:#fff;color:#1d1a17;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,.3);display:flex;flex-direction:column;overflow:hidden;font:14px/1.4 system-ui,sans-serif;}" +
        ".agx-assist-head{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid #e4dfd7;flex-shrink:0;}" +
        ".agx-assist-title{font-weight:600;font-size:15px;}" +
        ".agx-assist-status{color:#6f6a63;font-size:12.5px;flex:1;}" +
        ".agx-assist-close{background:none;border:0;color:#6f6a63;font-size:20px;line-height:1;padding:0;cursor:pointer;}" +
        ".agx-assist-body{overflow-y:auto;padding:4px 16px 16px;}" +
        ".agx-assist-section{padding:14px 0;border-bottom:1px solid #e4dfd7;}" +
        ".agx-assist-section:last-child{border-bottom:0;}" +
        ".agx-assist-heading{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6f6a63;margin:0 0 10px;font-weight:600;}" +
        ".agx-assist-empty{color:#6f6a63;font-size:14px;margin:0;}" +
        ".agx-assist-tray{display:flex;flex-direction:column;gap:10px;}" +
        ".agx-card{border:1px solid #e4dfd7;border-radius:6px;padding:10px 12px;font-size:14px;}" +
        ".agx-card-title{font-weight:600;margin-bottom:2px;}" +
        ".agx-card-text{margin-bottom:4px;}" +
        ".agx-card-time{color:#6f6a63;font-size:12px;margin-bottom:8px;}" +
        ".agx-card-actions{display:flex;gap:12px;flex-wrap:wrap;}" +
        ".agx-card-actions button{background:none;border:0;padding:0;font-size:13px;color:#6f6a63;text-decoration:underline;text-underline-offset:2px;cursor:pointer;}" +
        // Tray/badge-desync fix (finding B): a resolved suggestion renders
        // inert/greyed rather than looking still-actionable.
        ".agx-card.is-resolved{opacity:.55;}" +
        ".agx-assist-noticed{font-size:14px;}" +
        ".agx-noticed-signals{margin:0 0 8px;padding-left:18px;color:#6f6a63;}" +
        ".agx-noticed-signals-empty{color:#6f6a63;margin:0 0 8px;}" +
        ".agx-noticed-hypothesis{font-style:italic;margin:0 0 6px;}" +
        ".agx-noticed-decision{margin:0;}" +
        ".agx-assist-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}" +
        ".agx-toggle-btn{background:#1d1a17;color:#fbf9f5;border:0;border-radius:999px;padding:8px 16px;font-size:13px;cursor:pointer;}" +
        ".agx-toggle-btn[aria-pressed=\"false\"]{background:#8a8378;}" +
        ".agx-clear-btn{background:none;border:1px solid #e4dfd7;border-radius:4px;padding:6px 10px;font-size:13px;cursor:pointer;}" +
        ".agx-clear-btn:disabled{opacity:.5;cursor:default;}" +
        ".agx-tester-row{margin-bottom:8px;font-size:13px;}" +
        ".agx-tester-row:last-child{margin-bottom:0;}" +
        ".agx-tester-row button{background:none;border:1px solid #e4dfd7;border-radius:4px;padding:6px 10px;font-size:13px;cursor:pointer;}" +
        ".agx-tester-result{margin-left:10px;color:#6f6a63;}" +
        "@media (max-width:400px){.agx-launcher{right:12px;bottom:12px;}.agx-assist{right:12px;left:12px;width:auto;bottom:76px;}}";
      var style = document.createElement("style");
      style.setAttribute("data-agx", "true");
      style.setAttribute("data-agx-ui", "");
      style.textContent = css;
      document.head.appendChild(style);
    }
    // ----
    window.AgentEmbed = {
      version: "1.0.0",
      session: session,
      setEnabled: safe(setEnabled),
      rescan: safe(function () { var changed = discoverTargets(); if (changed) sendPageViewIfChanged(); }),
      targets: function () { return state.targets.slice(); },
      facts: function () { return state.facts; },
      _extract: extractFactsFrom
    };
  }
})();
