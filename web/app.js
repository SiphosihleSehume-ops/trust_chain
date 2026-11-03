/*
 * Batch Check: public verification page.
 *
 * This file only DISPLAYS what the API returns. Every verdict comes from the server's verification
 * engine; nothing here decides whether a batch is genuine. All API data is inserted as text
 * (textContent), never as HTML.
 */
(function () {
  "use strict";

  var form = document.getElementById("form");
  var batchInput = document.getElementById("batch");
  var recipientInput = document.getElementById("recipient");
  var submitBtn = document.getElementById("submit");
  var errorEl = document.getElementById("batch-error");
  var resultEl = document.getElementById("result");
  var statusEl = document.getElementById("status");
  var scanBtn = document.getElementById("scan");
  var stopScanBtn = document.getElementById("stop-scan");
  var scannerEl = document.getElementById("scanner");
  var video = document.getElementById("video");

  //  helpers

  /** Tiny DOM builder: el("p", {class: "x"}, "text", childNode). Strings become text nodes. */
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (attrs[k] === false || attrs[k] == null) return;
        node.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child == null || child === false) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  var HASH_RE = /^0x[0-9a-fA-F]{64}$/;
  var ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

  function shorten(value) {
    if (HASH_RE.test(value)) return value.slice(0, 10) + "…" + value.slice(-6);
    if (ADDR_RE.test(value)) return value.slice(0, 6) + "…" + value.slice(-4);
    return value;
  }

  /** A short form of an address/hash that shows the full value on hover and to screen readers. */
  function code(value) {
    return el("span", { title: value }, shorten(value));
  }

  function formatDate(seconds) {
    if (!seconds) return "";
    return new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  /** "documentHash" -> "Document hash", "lot_number" -> "Lot number" */
  function humanise(key) {
    var words = key.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  function section(title, body) {
    return el("section", null, el("h3", null, title), body);
  }

  function announce(message) {
    statusEl.textContent = message;
  }

  //  API

  function getJson(url) {
    return fetch(url).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var err = new Error(body.error || "The service returned an error (" + res.status + ").");
          err.status = res.status;
          throw err;
        }
        return body;
      });
    });
  }

  //  rendering

  var CHECK_WORDS = {
    verified: ["Passed", "passed"],
    failed: ["Failed", "failed"],
    missing: ["Missing", "missing"],
    not_checked: ["Not checked", "skipped"],
  };

  function findCheck(report, id) {
    for (var i = 0; i < report.checks.length; i++) if (report.checks[i].id === id) return report.checks[i];
    return null;
  }

  // Customer-facing wording for each check. The engine's own headlines are more technical; they are
  // still shown under "What was checked". Unknown ids fall back to the engine's headline.
  var TITLES = {
    batch_registered: "Batch is registered",
    supplier_authorised_at_registration: "Supplier was authorised",
    metadata_hash_matches: "Product details match the record",
    shipment_recorded: "Shipment recorded",
    expected_recipient_matches: "Recipient is the one expected",
    receipt_confirmed: "Delivery confirmed by the recipient",
    event_sequence: "Records are in a sensible order",
    records_consistent: "Records agree with each other",
  };

  var PLAIN = {
    missing: {
      supplier_authorised_at_registration: "The supplier\u2019s authorisation could not be confirmed.",
      metadata_hash_matches: "The product details could not be found, so they could not be checked.",
      shipment_recorded: "No shipment has been recorded yet.",
      expected_recipient_matches: "The expected recipient could not be checked because nothing has shipped.",
      receipt_confirmed: "The recipient has not confirmed delivery yet.",
      event_sequence: "There are too few records to check their order.",
      records_consistent: "Some records could not be cross-checked.",
    },
    failed: {
      supplier_authorised_at_registration: "The supplier was not authorised when it registered this batch.",
      metadata_hash_matches: "The product details do not match what the supplier recorded.",
      expected_recipient_matches: "The shipment names a different recipient than the one you expected.",
      receipt_confirmed: "The delivery confirmation does not match the shipment.",
      event_sequence: "The records were made in an impossible order.",
      records_consistent: "Some records contradict each other.",
    },
  };

  function headlinesWhere(report, status) {
    var skipReceipt = status === "missing" && findCheck(report, "shipment_recorded") &&
      findCheck(report, "shipment_recorded").status === "missing"; // "no shipment" already says it
    return report.checks
      .filter(function (c) { return c.status === status && !(skipReceipt && c.id === "receipt_confirmed"); })
      .map(function (c) { return (PLAIN[status] && PLAIN[status][c.id]) || c.headline; });
  }

  function verdictBlock(report) {
    var cls, title, lines, caveat;
    switch (report.overall) {
      case "verified":
        cls = "ok";
        title = "The records are complete and consistent";
        lines = ["The supplier was authorised, the product details match what was recorded, and the recipient confirmed receipt."];
        caveat = "This confirms the records, not the physical item. QR codes can be copied, so also check the packaging.";
        break;
      case "incomplete":
        cls = "warn";
        title = "Some records are missing";
        lines = headlinesWhere(report, "missing");
        caveat = "Nothing contradicts the records so far, but the full journey cannot be confirmed yet.";
        break;
      case "suspicious":
        cls = "bad";
        title = "The records conflict";
        lines = headlinesWhere(report, "failed");
        caveat = "Do not rely on this batch until the supplier has explained the difference.";
        break;
      default:
        cls = "warn";
        title = "No record found";
        lines = [report.summary];
        caveat = "Check the batch code for typing mistakes, or ask the seller where the batch was registered.";
    }
    return el("div", { class: "verdict " + cls },
      el("h2", null, title),
      el("p", null, lines.join(" ")),
      el("p", { class: "caveat" }, caveat));
  }

  function productSection(report, metadata) {
    var metaCheck = findCheck(report, "metadata_hash_matches");
    if (!metadata || !metaCheck || metaCheck.status !== "verified") {
      var reason = metaCheck && metaCheck.status === "failed"
        ? "The stored product details do not match the record, so they are not shown."
        : "Product details were not available to check, so none are shown.";
      return section("Product", el("p", null, reason));
    }
    var dl = el("dl", { class: "facts" });
    Object.keys(metadata).forEach(function (key) {
      var value = metadata[key];
      var text = typeof value === "string" ? value : JSON.stringify(value);
      dl.appendChild(el("dt", null, humanise(key)));
      dl.appendChild(el("dd", null, HASH_RE.test(text) ? code(text) : text));
    });
    return section("Product", dl);
  }

  function journeySection(report) {
    var list = el("ol", { class: "journey" });
    var batch = report.batch;
    if (!batch) return null;

    // 1. Registration by the supplier
    var auth = findCheck(report, "supplier_authorised_at_registration");
    var regLi = el("li", { class: auth && auth.status === "failed" ? "problem" : "" },
      el("div", { class: "what" }, "Registered by the supplier"),
      el("div", { class: "when" }, formatDate(batch.registeredAt)),
      el("div", { class: "who" }, "Supplier wallet ", code(batch.supplier)));
    if (auth) {
      var authText = auth.status === "verified" ? "Authorised by the administrator before registering."
        : auth.status === "failed" ? "Not authorised at the time of registration."
        : "Authorisation at the time of registration could not be confirmed.";
      regLi.appendChild(el("div", auth.status === "verified" ? { class: "who" } : { class: "problem-text" }, authText));
    }
    if (!batch.supplierCurrentlyAuthorised) {
      regLi.appendChild(el("div", { class: "problem-text" }, "This supplier’s authorisation has since been withdrawn."));
    }
    list.appendChild(regLi);

    // 2. Each shipment and its receipt
    var receiptCheck = findCheck(report, "receipt_confirmed");
    if (report.shipments.length === 0) {
      list.appendChild(el("li", { class: "pending" }, el("div", { class: "what" }, "Not shipped yet")));
    }
    report.shipments.forEach(function (s, i) {
      var isLatest = i === report.shipments.length - 1;
      list.appendChild(el("li", null,
        el("div", { class: "what" }, "Shipped to a distributor"),
        el("div", { class: "when" }, formatDate(s.shippedAt)),
        el("div", { class: "who" }, "Recipient wallet ", code(s.recipient))));

      if (s.receiptConfirmed) {
        var bad = isLatest && receiptCheck && receiptCheck.status === "failed";
        list.appendChild(el("li", { class: bad ? "problem" : "" },
          el("div", { class: "what" }, "Receipt confirmed by the recipient"),
          el("div", { class: "when" }, formatDate(s.receivedAt)),
          bad ? el("div", { class: "problem-text" }, receiptCheck.headline) : null));
      } else {
        list.appendChild(el("li", { class: "pending" },
          el("div", { class: "what" }, "Waiting for the recipient to confirm receipt")));
      }
    });

    return section("Journey", list);
  }

  function checksSection(report) {
    var ul = el("ul", { class: "checks" });
    report.checks.forEach(function (c) {
      var word = CHECK_WORDS[c.status] || [c.status, ""];
      ul.appendChild(el("li", null,
        el("span", { class: "state " + word[1] }, word[0]),
        el("span", null, el("span", { class: "title" }, TITLES[c.id] || c.title), el("span", { class: "headline" }, c.headline))));
    });
    return section("What was checked", ul);
  }

  function limitsSection(report) {
    var ul = el("ul", { class: "limits" });
    report.limitations.forEach(function (text) {
      if (/AI-generated/.test(text)) return; // this page shows no AI text; add back when Phase 4 does
      ul.appendChild(el("li", null, text));
    });
    return section("What this result does not tell you", ul);
  }

  function shareSection(batchCode) {
    var url = location.origin + location.pathname + "?batch=" + encodeURIComponent(batchCode);
    var qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    var holder = el("div", { class: "qr", role: "img", "aria-label": "QR code linking to this batch" });
    holder.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); // generated by the QR library, no user markup

    var copy = el("button", { type: "button" }, "Copy link");
    copy.addEventListener("click", function () {
      var done = function () { copy.textContent = "Link copied"; setTimeout(function () { copy.textContent = "Copy link"; }, 2000); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () {});
    });

    return section("Share this check",
      el("div", { class: "share" }, holder,
        el("div", null,
          el("p", null, "Anyone who scans this code or opens the link sees the same live check."),
          el("p", { class: "link" }, url),
          copy)));
  }

  function techSection(report) {
    var dl = el("dl", { class: "facts" });
    function row(k, v) { dl.appendChild(el("dt", null, k)); dl.appendChild(el("dd", null, v)); }
    row("Batch ID", report.batchId);
    row("Checked at block", String(report.checkedAtBlock));
    if (report.batch) {
      row("Product details hash", report.batch.metadataHash);
      row("Supplier wallet", report.batch.supplier);
    }
    report.shipments.forEach(function (s, i) { row("Recipient wallet" + (report.shipments.length > 1 ? " " + (i + 1) : ""), s.recipient); });
    return el("details", { class: "tech" }, el("summary", null, "Technical details"), dl);
  }

  function render(report, metadata, batchCode) {
    clear(resultEl);
    resultEl.appendChild(verdictBlock(report));

    if (report.warnings && report.warnings.length) {
      report.warnings.forEach(function (w) { resultEl.appendChild(el("p", { class: "notice" }, w)); });
    }
    if (report.overall !== "not_found") {
      resultEl.appendChild(productSection(report, metadata));
      resultEl.appendChild(journeySection(report));
      resultEl.appendChild(checksSection(report));
    }
    resultEl.appendChild(limitsSection(report));
    if (report.overall !== "not_found") {
      resultEl.appendChild(shareSection(batchCode));
      resultEl.appendChild(techSection(report));
    }
    resultEl.hidden = false;
  }

  function renderProblem(message) {
    clear(resultEl);
    resultEl.appendChild(el("div", { class: "verdict bad" },
      el("h2", null, "No result"),
      el("p", null, message),
      el("p", { class: "caveat" }, "A result is only shown when the blockchain record could be read. Try again in a moment.")));
    resultEl.hidden = false;
  }

  //  lookup flow

  var inFlight = 0;

  function check(batchCode) {
    batchCode = batchCode.trim();
    errorEl.hidden = true;
    if (!batchCode) {
      errorEl.textContent = "Enter a batch code to check.";
      errorEl.hidden = false;
      batchInput.focus();
      return;
    }
    batchInput.value = batchCode;

    var query = "";
    var recipient = recipientInput.value.trim();
    if (recipient) query = "?expectedRecipient=" + encodeURIComponent(recipient);

    var ticket = ++inFlight; // ignore a slow earlier answer if a newer lookup was started
    submitBtn.disabled = true;
    submitBtn.textContent = "Checking…";
    announce("Checking batch");

    getJson("/api/verify/" + encodeURIComponent(batchCode) + query)
      .then(function (report) {
        // Product details are only fetched if the batch exists; the engine decides whether to trust them.
        var needsMeta = report.batch && report.batch.metadataHash;
        var metaPromise = needsMeta
          ? getJson("/api/metadata/" + report.batch.metadataHash).catch(function () { return null; })
          : Promise.resolve(null);
        return metaPromise.then(function (metadata) { return { report: report, metadata: metadata }; });
      })
      .then(function (r) {
        if (ticket !== inFlight) return;
        render(r.report, r.metadata, batchCode);
        history.replaceState(null, "", "?batch=" + encodeURIComponent(batchCode));
        announce("Result ready");
        resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
      })
      .catch(function (err) {
        if (ticket !== inFlight) return;
        if (err.status === 400) {
          errorEl.textContent = /expectedRecipient/.test(err.message)
            ? "That recipient address is not valid. It should start with 0x and be 42 characters long."
            : "That batch code is not valid. Use 1 to 128 characters.";
          errorEl.hidden = false;
          resultEl.hidden = true;
        } else {
          renderProblem(err.status ? err.message : "The verification service could not be reached.");
        }
        announce("No result");
      })
      .then(function () {
        if (ticket !== inFlight) return;
        submitBtn.disabled = false;
        submitBtn.textContent = "Check batch";
      });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    check(batchInput.value);
  });

  //  QR scanning (camera)

  var stream = null;

  function batchFromScan(raw) {
    try {
      var u = new URL(raw);
      return u.searchParams.get("batch") || raw;
    } catch (e) {
      return raw;
    }
  }

  function stopScan() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    video.srcObject = null;
    scannerEl.hidden = true;
  }

  function startScan() {
    var detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then(function (s) {
        stream = s;
        video.srcObject = s;
        scannerEl.hidden = false;
        return video.play();
      })
      .then(function () {
        (function tick() {
          if (!stream) return;
          detector.detect(video).then(function (codes) {
            if (codes.length) {
              var batch = batchFromScan(codes[0].rawValue);
              stopScan();
              check(batch);
            } else {
              requestAnimationFrame(tick);
            }
          }).catch(function () { requestAnimationFrame(tick); });
        })();
      })
      .catch(function () {
        stopScan();
        errorEl.textContent = "The camera could not be opened. Allow camera access, or type the batch code instead.";
        errorEl.hidden = false;
      });
  }

  // Only offer scanning where the browser can actually do it.
  if ("BarcodeDetector" in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    scanBtn.hidden = false;
    scanBtn.addEventListener("click", startScan);
    stopScanBtn.addEventListener("click", stopScan);
  }

  //  deep link (?batch=...)

  var initial = new URLSearchParams(location.search).get("batch");
  if (initial) check(initial);
})();
