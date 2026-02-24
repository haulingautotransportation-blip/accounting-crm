<script type="module">
    import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
    import {
      getFirestore, collection, addDoc, serverTimestamp,
      query, orderBy, limit, onSnapshot, where, getDocs,
      doc, setDoc, deleteDoc
    } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

    const firebaseConfig = {
      apiKey: "AIzaSyBZti11UlAEp5_7fcB9r8l7i1HpIQxhLwg",
      authDomain: "accounting-crm-web.firebaseapp.com",
      projectId: "accounting-crm-web",
      storageBucket: "accounting-crm-web.firebasestorage.app",
      messagingSenderId: "312052820860",
      appId: "1:312052820860:web:38dabd80841df9de99d2f9"
    };

    const app = initializeApp(firebaseConfig);
    const db = getFirestore(app);

    const el = (id) => document.getElementById(id);

    // ---------- CATEGORY RULES (Accounting Logic) ----------
    const INCOME_CATEGORIES = new Set(["Sales", "Other Income", "Sales Reimbursement"]);
    const EXPENSE_CATEGORIES = new Set(["COGS", "Repairs & Maintenance", "Fuel", "Payroll", "Contract Labor", "Other Expense"]);
    const EXCLUDED_CATEGORIES = new Set(["Loan from Others", "Internal Transfer"]);
    // ------------------------------------------------------

    // Tabs
    const tabButtons = Array.from(document.querySelectorAll(".tabBtn"));
    const panels = {
      dashboard: el("tab-dashboard"),
      transactions: el("tab-transactions"),
      vendors: el("tab-vendors"),
      ap: el("tab-ap"),
      audit: el("tab-audit"),
      importexport: el("tab-importexport"),
      archive: el("tab-archive"),
    };

    tabButtons.forEach(btn => {
      btn.addEventListener("click", async () => {
        tabButtons.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        Object.values(panels).forEach(p => p.classList.remove("active"));
        panels[btn.dataset.tab].classList.add("active");

        // refresh when opening tabs
        if (btn.dataset.tab === "transactions") await refreshTransactionsView(true);
        if (btn.dataset.tab === "vendors") await refreshVendors();
        if (btn.dataset.tab === "ap") await refreshAP();
        if (btn.dataset.tab === "audit") await refreshLockedMonthsUI();
      });
    });

    // Defaults
    el("date").value = new Date().toISOString().slice(0,10);
    el("monthPick").value = new Date().toISOString().slice(0,7);
    el("auditMonth").value = new Date().toISOString().slice(0,7);
    el("exportMonth").value = "";
    el("archiveMonth").value = new Date().toISOString().slice(0,7);

    // Transactions tab defaults
    el("txMonth").value = "";
    el("txAccount").value = "ALL";
    el("txGroup").value = "ALL";
    el("txTxnType").value = "ALL";
    el("txCategory").value = "ALL";
    el("txSort").value = "date_desc";
    el("txPageSize").value = "50";

    // Editing safety (global)
    const EDIT_MODE_KEY = "crm_edit_mode_enabled";
    function getEditMode(){
      return localStorage.getItem(EDIT_MODE_KEY) === "1";
    }
    function setEditMode(on){
      localStorage.setItem(EDIT_MODE_KEY, on ? "1" : "0");
      applyEditModeUI();
    }
    function applyEditModeUI(){
      const on = getEditMode();
      el("editModeToggle").checked = on;
      el("editModePill").textContent = on ? "Editing: ON" : "Editing: OFF";
      el("editModePill").classList.toggle("ok", on);
      el("editModePill").classList.toggle("danger", !on);

      // disable risky actions
      el("saveBtn").disabled = !on;
      el("importBtn").disabled = !on;
      el("importFile").disabled = !on;

      // still allow export always
    }
    el("editModeToggle").addEventListener("change", (e) => setEditMode(e.target.checked));

    // Lock cache: set of "YYYY-MM"
    const lockedMonths = new Set();

    function monthKeyFromDate(dateStr){
      // expects YYYY-MM-DD
      return String(dateStr || "").slice(0,7);
    }

    async function loadLockedMonths(){
      lockedMonths.clear();
      const snap = await getDocs(collection(db, "locks"));
      snap.forEach(d => lockedMonths.add(d.id)); // doc id = YYYY-MM
      updateLockBadge();
    }

    function updateLockBadge(){
      const mk = monthKeyFromDate(el("date").value);
      if (!mk) return;
      if (lockedMonths.has(mk)){
        el("lockBadge").textContent = "Lock: " + mk + " LOCKED";
        el("lockBadge").classList.add("danger");
        el("lockBadge").classList.remove("ok");
      } else {
        el("lockBadge").textContent = "Lock: " + mk + " open";
        el("lockBadge").classList.remove("danger");
        el("lockBadge").classList.add("ok");
      }
    }

    el("date").addEventListener("change", updateLockBadge);

    // Clear
    el("clearBtn").onclick = () => {
      el("amount").value = "";
      el("description").value = "";
      el("account").value = "8930";
      el("category").value = "Sales";
      el("vendor").value = "";
      el("txnType").value = "";
      el("refNo").value = "";
      el("vendorGroup").value = "General";
      el("date").value = new Date().toISOString().slice(0,10);
      el("status").textContent = "";
      updateLockBadge();
    };

    // Save
    el("saveBtn").onclick = async () => {
      if (!getEditMode()){
        el("status").textContent = "❌ Editing is OFF (Audit Monthly → Editing Safety)";
        return;
      }

      const date = el("date").value.trim();
      const amountStr = el("amount").value.trim();
      const amount = Number(amountStr);
      const account = el("account").value;
      const category = el("category").value;
      const description = el("description").value.trim();

      const vendor = el("vendor").value.trim();
      const txnType = el("txnType").value;
      const refNo = el("refNo").value.trim();
      const vendorGroup = el("vendorGroup").value;

      const mk = monthKeyFromDate(date);
      if (lockedMonths.has(mk)){
        el("status").textContent = "❌ Month is locked: " + mk;
        return;
      }

      if (!date) return el("status").textContent = "❌ Date required";
      if (!amountStr || Number.isNaN(amount)) return el("status").textContent = "❌ Amount required";
      if (!description) return el("status").textContent = "❌ Description required";

      // If vendor is provided, require txnType for AP accuracy
      if (vendor && !txnType){
        el("status").textContent = "❌ If Vendor is filled, choose Txn Type (BILL/PAYMENT/CREDIT)";
        return;
      }

      try {
        const payload = {
          date, amount, account, category, description,
          createdAt: serverTimestamp()
        };

        // Optional new fields (backward compatible)
        if (vendor) payload.vendor = vendor;
        if (txnType) payload.txnType = txnType;
        if (refNo) payload.refNo = refNo;
        if (vendorGroup) payload.vendorGroup = vendorGroup;

        const docRef = await addDoc(collection(db, "transactions"), payload);

        el("status").textContent = "✅ Saved: " + docRef.id;
        el("amount").value = "";
        el("description").value = "";
        await refreshMonthlySummary();
        await refreshVendorListDatalist();
        await refreshTransactionsView(false);
      } catch (e) {
        console.error(e);
        el("status").textContent = "❌ " + e.message;
      }
    };

    // Recent list
    let unsubscribe = null;

    function escapeHtml(str){
      return String(str)
        .replaceAll("&","&amp;")
        .replaceAll("<","&lt;")
        .replaceAll(">","&gt;")
        .replaceAll('"',"&quot;")
        .replaceAll("'","&#039;");
    }

    function renderList(snap){
      el("list").innerHTML = "";
      snap.forEach((docSnap) => {
        const t = docSnap.data();
        const div = document.createElement("div");
        div.className = "item";
        div.innerHTML = `
          <div><b>Date:</b> ${t.date || ""}</div>
          <div><b>Amount:</b> ${t.amount ?? ""}</div>
          <div><b>Acct:</b> ${t.account || ""} &nbsp; <b>Cat:</b> ${t.category || ""}</div>
          <div><b>Vendor:</b> ${escapeHtml(t.vendor || "")} <span class="muted">${t.txnType ? "(" + t.txnType + ")" : ""}</span></div>
          <div><b>Ref:</b> ${escapeHtml(t.refNo || "")}</div>
          <div><b>Memo:</b> ${escapeHtml(t.description || "")}</div>
        `;
        el("list").appendChild(div);
      });
    }

    function subscribeRecent(){
      if (unsubscribe) unsubscribe();
      const selected = el("filterAccount").value;

      let q;
      if (selected === "ALL") {
        q = query(collection(db, "transactions"), orderBy("createdAt", "desc"), limit(10));
      } else {
        q = query(
          collection(db, "transactions"),
          where("account", "==", selected),
          orderBy("createdAt", "desc"),
          limit(10)
        );
      }
      unsubscribe = onSnapshot(q, renderList);
    }

    // Monthly summary
    function monthRange(monthValue){
      const [y, m] = monthValue.split("-").map(Number);
      const start = `${y}-${String(m).padStart(2,"0")}-01`;
      const endDate = new Date(y, m, 0);
      const end = `${y}-${String(m).padStart(2,"0")}-${String(endDate.getDate()).padStart(2,"0")}`;
      return { start, end };
    }

    function money(n){
      const num = Number(n || 0);
      return num.toLocaleString(undefined, { style:"currency", currency:"USD" });
    }

    async function refreshMonthlySummary(){
      const monthValue = el("monthPick").value;
      const { start, end } = monthRange(monthValue);
      const selected = el("filterAccount").value;

      let q;
      if (selected === "ALL") {
        q = query(
          collection(db, "transactions"),
          where("date", ">=", start),
          where("date", "<=", end)
        );
      } else {
        q = query(
          collection(db, "transactions"),
          where("account", "==", selected),
          where("date", ">=", start),
          where("date", "<=", end)
        );
      }

      const snap = await getDocs(q);

      let income = 0;
      let expense = 0;

      snap.forEach((d) => {
        const t = d.data();
        const amt = Number(t.amount || 0);
        const cat = String(t.category || "");

        if (EXCLUDED_CATEGORIES.has(cat)) return;

        if (INCOME_CATEGORIES.has(cat)) {
          income += Math.abs(amt);
          return;
        }
        if (EXPENSE_CATEGORIES.has(cat)) {
          expense += Math.abs(amt);
          return;
        }
      });

      el("sumIncome").textContent = money(income);
      el("sumExpense").textContent = money(expense);
      el("sumNet").textContent = money(income - expense);
    }

    el("filterAccount").addEventListener("change", async () => {
      subscribeRecent();
      await refreshMonthlySummary();
    });
    el("monthPick").addEventListener("change", refreshMonthlySummary);

    // Vendor datalist
    async function refreshVendorListDatalist(){
      const snap = await getDocs(collection(db, "transactions"));
      const vendors = new Set();
      snap.forEach(d => {
        const v = (d.data().vendor || "").trim();
        if (v) vendors.add(v);
      });
      const list = el("vendorList");
      list.innerHTML = "";
      Array.from(vendors).sort().forEach(v => {
        const opt = document.createElement("option");
        opt.value = v;
        list.appendChild(opt);
      });
    }

    // Build Vendor aggregates for AP
    function apSign(txnType, amount){
      const a = Math.abs(Number(amount || 0));
      if (txnType === "BILL") return +a;
      if (txnType === "PAYMENT") return -a;
      if (txnType === "CREDIT") return -a;
      return 0;
    }

    async function computeVendorAggregates(){
      const snap = await getDocs(collection(db, "transactions"));
      const map = new Map(); // vendor -> {group, balance, bills, payments, credits, items[]}

      snap.forEach(d => {
        const t = d.data();
        const vendor = (t.vendor || "").trim();
        const txnType = (t.txnType || "").trim();
        if (!vendor || !txnType) return;

        const group = t.vendorGroup || "General";
        if (!map.has(vendor)){
          map.set(vendor, { vendor, group, balance:0, bills:0, payments:0, credits:0, items:[] });
        }
        const obj = map.get(vendor);
        obj.group = obj.group || group;

        const a = Math.abs(Number(t.amount || 0));
        if (txnType === "BILL") obj.bills += a;
        if (txnType === "PAYMENT") obj.payments += a;
        if (txnType === "CREDIT") obj.credits += a;

        obj.balance += apSign(txnType, t.amount);
        obj.items.push({
          date: t.date || "",
          txnType,
          amount: a,
          refNo: t.refNo || "",
          account: t.account || "",
          category: t.category || "",
          description: t.description || ""
        });
      });

      // sort ledger items
      map.forEach(v => v.items.sort((a,b) => (a.date||"").localeCompare(b.date||"")));
      return map;
    }

    // Vendors UI
    let vendorAggCache = new Map();
    let selectedVendor = "";

    async function refreshVendors(){
      vendorAggCache = await computeVendorAggregates();
      const body = el("vendorTableBody");
      body.innerHTML = "";

      const search = (el("vendorSearch").value || "").toLowerCase().trim();
      const groupFilter = el("vendorGroupFilter").value;

      const rows = Array.from(vendorAggCache.values())
        .filter(v => !search || v.vendor.toLowerCase().includes(search))
        .filter(v => groupFilter === "ALL" || (v.group || "General") === groupFilter)
        .sort((a,b) => Math.abs(b.balance) - Math.abs(a.balance));

      rows.forEach(v => {
        const tr = document.createElement("tr");
        tr.style.cursor = "pointer";
        tr.innerHTML = `
          <td>${escapeHtml(v.vendor)}</td>
          <td>${escapeHtml(v.group || "General")}</td>
          <td class="right ${v.balance > 0 ? "danger" : ""}">${money(v.balance)}</td>
          <td class="right">${money(v.bills)}</td>
          <td class="right">${money(v.payments)}</td>
          <td class="right">${money(v.credits)}</td>
        `;
        tr.addEventListener("click", () => {
          selectedVendor = v.vendor;
          el("selectedVendorPill").textContent = "Selected: " + selectedVendor;
          renderVendorLedger(selectedVendor);
        });
        body.appendChild(tr);
      });

      if (selectedVendor && vendorAggCache.has(selectedVendor)){
        renderVendorLedger(selectedVendor);
      } else {
        el("vendorLedgerBody").innerHTML = "";
        el("selectedVendorPill").textContent = "No vendor selected";
      }
    }

    function renderVendorLedger(vendorName){
      const v = vendorAggCache.get(vendorName);
      if (!v) return;
      const body = el("vendorLedgerBody");
      body.innerHTML = "";
      v.items.forEach(it => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${escapeHtml(it.date)}</td>
          <td>${escapeHtml(it.txnType)}</td>
          <td class="right">${money(it.amount)}</td>
          <td>${escapeHtml(it.refNo)}</td>
          <td>${escapeHtml(it.account)}</td>
          <td>${escapeHtml(it.category)}</td>
          <td>${escapeHtml(it.description)}</td>
        `;
        body.appendChild(tr);
      });
    }

    el("vendorSearch").addEventListener("input", refreshVendors);
    el("vendorGroupFilter").addEventListener("change", refreshVendors);

    // AP Summary UI
    async function refreshAP(){
      vendorAggCache = await computeVendorAggregates();
      const apBody = el("apBody");
      apBody.innerHTML = "";

      const rows = Array.from(vendorAggCache.values())
        .sort((a,b) => Math.abs(b.balance) - Math.abs(a.balance));

      rows.forEach(v => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${escapeHtml(v.vendor)}</td>
          <td>${escapeHtml(v.group || "General")}</td>
          <td class="right ${v.balance > 0 ? "danger" : ""}">${money(v.balance)}</td>
        `;
        apBody.appendChild(tr);
      });
    }

    el("refreshAPBtn").addEventListener("click", refreshAP);

    // Locks UI
    async function refreshLockedMonthsUI(){
      await loadLockedMonths();
      const list = Array.from(lockedMonths).sort();
      el("lockedMonthsList").innerHTML = list.length
        ? list.map(m => `<div>🔒 ${m}</div>`).join("")
        : "No locked months.";
      const mk = el("auditMonth").value;
      el("auditStatus").textContent = lockedMonths.has(mk) ? `🔒 ${mk} is LOCKED` : `✅ ${mk} is open`;
    }

    el("auditMonth").addEventListener("change", refreshLockedMonthsUI);

    el("lockMonthBtn").addEventListener("click", async () => {
      const mk = el("auditMonth").value;
      if (!mk) return;
      await setDoc(doc(db, "locks", mk), { lockedAt: serverTimestamp() });
      await refreshLockedMonthsUI();
      updateLockBadge();
    });

    el("unlockMonthBtn").addEventListener("click", async () => {
      const mk = el("auditMonth").value;
      if (!mk) return;
      await deleteDoc(doc(db, "locks", mk));
      await refreshLockedMonthsUI();
      updateLockBadge();
    });

    // Import / Export helpers
    function normalizeRow(row){
      // helper to read different header names
      const pick = (...keys) => {
        for (const k of keys){
          if (row[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
          const lk = String(k).toLowerCase();
          for (const rk of Object.keys(row)){
            if (String(rk).toLowerCase().trim() === lk) return row[rk];
          }
        }
        return "";
      };

      // Date (supports Date, Posting Date, Transaction Date)
      let rawDate = pick("date","Date","Posting Date","Transaction Date","Trans Date");
      let date = "";

      // If excel gives Date object
      if (rawDate instanceof Date){
        date = rawDate.toISOString().slice(0,10);
      } else {
        const s = String(rawDate).trim();
        // try YYYY-MM-DD already
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) date = s;
        // try MM/DD/YYYY
        else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
          const [mm,dd,yyyy] = s.split("/");
          date = `${yyyy}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}`;
        }
      }

      // Description / memo
      const description = String(pick("description","Description","Memo","Details","Transaction","Name","Payee")).trim();

      // Amount (supports Amount OR Debit/Credit columns)
      let amountVal = pick("amount","Amount");
      let amount = Number(amountVal);

      if (Number.isNaN(amount) || amountVal === "") {
        const debit = Number(pick("debit","Debit","Withdrawal","Withdrawals","Money Out","Out"));
        const credit = Number(pick("credit","Credit","Deposit","Deposits","Money In","In"));
        const d = Number.isNaN(debit) ? 0 : debit;
        const c = Number.isNaN(credit) ? 0 : credit;
        // debit negative, credit positive
        amount = (c !== 0 ? c : 0) - (d !== 0 ? d : 0);
      }

      if (!date) return { ok:false, reason:"bad date" };
      if (!description) return { ok:false, reason:"missing description" };
      if (Number.isNaN(amount)) return { ok:false, reason:"bad amount" };

      const out = {};
      out.date = date;
      out.amount = amount;

      // Optional fields (safe defaults)
      out.account = String(pick("account","Account","Acct","Bank","last4") || "OTHER").trim() || "OTHER";
      out.category = String(pick("category","Category") || "Other Expense").trim() || "Other Expense";
      out.vendor = String(pick("vendor","Vendor","Payee","Name") || "").trim();
      out.txnType = String(pick("txnType","TxnType","Type") || "").trim().toUpperCase();
      out.refNo = String(pick("refNo","Ref","Reference","Check #","Check Number") || "").trim();
      out.vendorGroup = String(pick("vendorGroup","Group") || "General").trim() || "General";
      out.description = description;

      // normalize txnType
      if (!["BILL","PAYMENT","CREDIT"].includes(out.txnType)) {
        out.txnType = out.vendor ? out.txnType : "";
      }

      return { ok:true, data: out };
    }

    function jsonToSheetAndDownload(rows, filename){
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(wb, ws, "data");
      XLSX.writeFile(wb, filename);
    }

    function jsonToCsvDownload(rows, filename){
      const ws = XLSX.utils.json_to_sheet(rows);
      const csv = XLSX.utils.sheet_to_csv(ws);
      const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    }

    // Template downloads
    const TEMPLATE_ROWS = [{
      date: "2026-01-21",
      amount: -2730.00,
      account: "8930",
      category: "COGS",
      description: "Wentworth invoice",
      vendor: "WENTWORTH TIRE SERVICES",
      txnType: "BILL",
      refNo: "INV12345",
      vendorGroup: "General"
    },{
      date: "2026-01-22",
      amount: -4592.20,
      account: "8930",
      category: "COGS",
      description: "Wentworth payment from bank",
      vendor: "WENTWORTH TIRE SERVICES",
      txnType: "PAYMENT",
      refNo: "90035199",
      vendorGroup: "General"
    }];

    el("downloadTemplateXlsx").addEventListener("click", () => {
      jsonToSheetAndDownload(TEMPLATE_ROWS, "transactions_import_template.xlsx");
    });
    el("downloadTemplateCsv").addEventListener("click", () => {
      jsonToCsvDownload(TEMPLATE_ROWS, "transactions_import_template.csv");
    });

    // Import
    el("importBtn").addEventListener("click", async () => {
      if (!getEditMode()){
        el("importStatus").textContent = "❌ Editing is OFF (Audit Monthly → Editing Safety)";
        return;
      }

      const f = el("importFile").files?.[0];
      if (!f) { el("importStatus").textContent = "❌ Select a file first"; return; }

      try {
        // Load locks first
        await loadLockedMonths();

        el("importStatus").textContent = "Reading file… (0%)";

        // --- 1) Read rows depending on file type ---
        let rows = [];
        const name = (f.name || "").toLowerCase();

        if (name.endsWith(".csv")) {
          const text = await f.text();
          el("importStatus").textContent = "Parsing CSV…";

          const wb = XLSX.read(text, { type: "string" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

        } else {
          const data = await f.arrayBuffer();
          el("importStatus").textContent = "Parsing Excel…";

          const wb = XLSX.read(data, { type: "array" });
          const ws = wb.Sheets[wb.SheetNames[0]];
          rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
        }

        if (!rows.length) {
          el("importStatus").textContent = "❌ No rows found in file.";
          return;
        }

        // --- 2) Normalize + validate first ---
        el("importStatus").textContent = `Validating ${rows.length} rows…`;

        const toInsert = [];
        let failCount = 0, skipCount = 0;

        for (const r of rows) {
          const norm = normalizeRow(r);
          if (!norm.ok) { failCount++; continue; }

          const mk = monthKeyFromDate(norm.data.date);
          if (lockedMonths.has(mk)) { skipCount++; continue; }

          toInsert.push({
            ...norm.data,
            createdAt: serverTimestamp()
          });
        }

        if (!toInsert.length) {
          el("importStatus").textContent = `❌ Nothing to import. Failed: ${failCount} • Skipped (locked): ${skipCount}`;
          return;
        }

        // --- 3) Insert in chunks ---
        el("importStatus").textContent = `Importing ${toInsert.length} rows…`;

        const CHUNK = 50;
        let okCount = 0;

        for (let i = 0; i < toInsert.length; i += CHUNK) {
          const batch = toInsert.slice(i, i + CHUNK);

          await Promise.all(
            batch.map(payload => addDoc(collection(db, "transactions"), payload))
          );

          okCount += batch.length;

          const pct = Math.round((okCount / toInsert.length) * 100);
          el("importStatus").textContent = `Importing… ${okCount}/${toInsert.length} (${pct}%)`;
        }

        el("importStatus").textContent =
          `✅ Imported: ${okCount} • Skipped (locked): ${skipCount} • Failed: ${failCount}`;

        await refreshMonthlySummary();
        await refreshVendorListDatalist();
        await refreshTransactionsView(true);

      } catch (e) {
        console.error(e);
        el("importStatus").textContent = "❌ Import error: " + (e?.message || e);
      }
    });

    // Export transactions (all or month)
    async function fetchTransactionsForExport({month="", account="ALL"}){
      let baseQuery = query(collection(db, "transactions"));
      const snap = await getDocs(baseQuery);

      const out = [];

      snap.forEach(d => {
        const t = d.data();
        if (month && monthKeyFromDate(t.date) !== month) return;
        if (account !== "ALL" && (t.account || "OTHER") !== account) return;

        out.push({
          date: t.date || "",
          amount: Number(t.amount || 0),
          account: t.account || "OTHER",
          category: t.category || "",
          description: t.description || "",
          vendor: t.vendor || "",
          txnType: t.txnType || "",
          refNo: t.refNo || "",
          vendorGroup: t.vendorGroup || "General"
        });
      });

      out.sort((a,b) => (a.date || "").localeCompare(b.date || ""));
      return out;
    }

    el("exportXlsx").addEventListener("click", async () => {
      const month = el("exportMonth").value || "";
      const account = el("exportAccount").value || "ALL";
      el("exportStatus").textContent = "Preparing export…";
      const rows = await fetchTransactionsForExport({ month: month, account: account });
      jsonToSheetAndDownload(rows, `transactions_export${month ? "_" + month : ""}.xlsx`);
      el("exportStatus").textContent = `✅ Exported ${rows.length} rows`;
    });

    el("exportCsv").addEventListener("click", async () => {
      const month = el("exportMonth").value || "";
      const account = el("exportAccount").value || "ALL";
      el("exportStatus").textContent = "Preparing export…";
      const rows = await fetchTransactionsForExport({ month: month, account: account });
      jsonToCsvDownload(rows, `transactions_export${month ? "_" + month : ""}.csv`);
      el("exportStatus").textContent = `✅ Exported ${rows.length} rows`;
    });

    // Export AP summary
    async function exportAPRows(){
      const agg = await computeVendorAggregates();
      const rows = Array.from(agg.values())
        .sort((a,b) => Math.abs(b.balance) - Math.abs(a.balance))
        .map(v => ({
          vendor: v.vendor,
          group: v.group || "General",
          balance_due: Number(v.balance.toFixed(2))
        }));
      return rows;
    }

    el("exportAPBtn").addEventListener("click", async () => {
      const rows = await exportAPRows();
      jsonToSheetAndDownload(rows, "ap_summary.xlsx");
    });

    el("exportAPCsvBtn").addEventListener("click", async () => {
      const rows = await exportAPRows();
      jsonToCsvDownload(rows, "ap_summary.csv");
    });

    // Archive export (month snapshot)
    async function exportArchive(kind){
      const month = el("archiveMonth").value;
      if (!month){ el("archiveStatus").textContent = "❌ Choose a month"; return; }
      el("archiveStatus").textContent = "Preparing archive…";
      const rows = await fetchTransactionsForExport({month, account:"ALL"});
      if (kind === "xlsx") jsonToSheetAndDownload(rows, `ARCHIVE_${month}.xlsx`);
      if (kind === "csv") jsonToCsvDownload(rows, `ARCHIVE_${month}.csv`);
      el("archiveStatus").textContent = `✅ Archive exported: ${rows.length} rows`;
    }
    el("archiveXlsxBtn").addEventListener("click", () => exportArchive("xlsx"));
    el("archiveCsvBtn").addEventListener("click", () => exportArchive("csv"));

    // =========================
    // TRANSACTIONS TAB (A+B+C+D)
    // =========================
    let txAllRowsCache = [];     // full pulled rows for the current base query
    let txFilteredRows = [];     // after filters/search
    let txPage = 1;

    function normalizeTxnForUI(t){
      return {
        date: t.date || "",
        amount: Number(t.amount || 0),
        account: t.account || "OTHER",
        category: t.category || "",
        vendor: t.vendor || "",
        txnType: t.txnType || "",
        refNo: t.refNo || "",
        vendorGroup: t.vendorGroup || "General",
        description: t.description || ""
      };
    }

    async function fetchBaseTransactionsForView(){
      // Light server filtering: by month (date range) and account
      const month = el("txMonth").value || "";
      const account = el("txAccount").value || "ALL";

      let q = query(collection(db, "transactions"));

      if (month){
        const { start, end } = monthRange(month);
        if (account === "ALL"){
          q = query(collection(db, "transactions"),
            where("date", ">=", start),
            where("date", "<=", end)
          );
        } else {
          q = query(collection(db, "transactions"),
            where("account", "==", account),
            where("date", ">=", start),
            where("date", "<=", end)
          );
        }
      } else {
        // No month: fetch a reasonable amount (latest 2000) then filter client-side
        if (account === "ALL"){
          q = query(collection(db, "transactions"), orderBy("createdAt", "desc"), limit(2000));
        } else {
          q = query(collection(db, "transactions"),
            where("account","==",account),
            orderBy("createdAt","desc"),
            limit(2000)
          );
        }
      }

      const snap = await getDocs(q);
      const rows = [];
      snap.forEach(d => rows.push(normalizeTxnForUI(d.data())));
      return rows;
    }

    function applyTxFilters(){
      const search = (el("txSearch").value || "").toLowerCase().trim();
      const group = el("txGroup").value || "ALL";
      const txnType = el("txTxnType").value || "ALL";
      const category = el("txCategory").value || "ALL";
      const account = el("txAccount").value || "ALL"; // already base-filtered, but keep safe

      let rows = txAllRowsCache.slice();

      if (account !== "ALL") rows = rows.filter(r => (r.account || "OTHER") === account);
      if (group !== "ALL") rows = rows.filter(r => (r.vendorGroup || "General") === group);
      if (category !== "ALL") rows = rows.filter(r => (r.category || "") === category);

      if (txnType !== "ALL"){
        if (txnType === "NONE") rows = rows.filter(r => !r.txnType);
        else rows = rows.filter(r => (r.txnType || "") === txnType);
      }

      if (search){
        rows = rows.filter(r => {
          const hay = `${r.vendor} ${r.description} ${r.refNo}`.toLowerCase();
          return hay.includes(search);
        });
      }

      // sort
      const sort = el("txSort").value;
      const byDate = (a,b) => (a.date || "").localeCompare(b.date || "");
      const byAmt = (a,b) => (a.amount || 0) - (b.amount || 0);

      if (sort === "date_asc") rows.sort(byDate);
      if (sort === "date_desc") rows.sort((a,b) => -byDate(a,b));
      if (sort === "amount_asc") rows.sort(byAmt);
      if (sort === "amount_desc") rows.sort((a,b) => -byAmt(a,b));

      txFilteredRows = rows;
    }

    function renderTxPage(){
      const pageSize = Number(el("txPageSize").value || 50);
      const total = txFilteredRows.length;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      txPage = Math.min(Math.max(1, txPage), pages);

      const startIdx = (txPage - 1) * pageSize;
      const endIdx = Math.min(total, startIdx + pageSize);
      const slice = txFilteredRows.slice(startIdx, endIdx);

      el("txBody").innerHTML = "";
      slice.forEach(r => {
        const tr = document.createElement("tr");
        const amtClass = r.amount < 0 ? "danger" : "";
        tr.innerHTML = `
          <td class="nowrap">${escapeHtml(r.date)}</td>
          <td class="right nowrap ${amtClass}">${money(r.amount)}</td>
          <td class="nowrap">${escapeHtml(r.account)}</td>
          <td class="nowrap">${escapeHtml(r.category)}</td>
          <td class="nowrap">${escapeHtml(r.vendor)}</td>
          <td class="nowrap">${escapeHtml(r.txnType)}</td>
          <td class="nowrap">${escapeHtml(r.refNo)}</td>
          <td>${escapeHtml(r.description)}</td>
        `;
        el("txBody").appendChild(tr);
      });

      el("txPagePill").textContent = `Page ${txPage} / ${pages}`;
      el("txCount").textContent = `Showing ${startIdx + 1}-${endIdx} of ${total} (base fetched: ${txAllRowsCache.length})`;
      el("txPrevBtn").disabled = txPage <= 1;
      el("txNextBtn").disabled = txPage >= pages;
    }

    async function refreshTransactionsView(resetPage){
      try{
        el("txStatus").textContent = "Loading…";
        if (resetPage) txPage = 1;

        txAllRowsCache = await fetchBaseTransactionsForView();
        applyTxFilters();
        renderTxPage();

        el("txStatus").textContent = "✅ Ready";
      } catch (e){
        console.error(e);
        el("txStatus").textContent = "❌ " + (e?.message || e);
      }
    }

    // Transactions controls events
    el("txRefreshBtn").addEventListener("click", () => refreshTransactionsView(true));
    el("txSearch").addEventListener("input", () => { applyTxFilters(); txPage = 1; renderTxPage(); });
    ["txMonth","txAccount","txGroup","txTxnType","txCategory","txSort","txPageSize"].forEach(id => {
      el(id).addEventListener("change", async () => {
        // month/account changes affect base query
        if (id === "txMonth" || id === "txAccount") await refreshTransactionsView(true);
        else { applyTxFilters(); txPage = 1; renderTxPage(); }
      });
    });
    el("txPrevBtn").addEventListener("click", () => { txPage--; renderTxPage(); });
    el("txNextBtn").addEventListener("click", () => { txPage++; renderTxPage(); });

    // Export current view
    el("txExportXlsxBtn").addEventListener("click", async () => {
      applyTxFilters();
      jsonToSheetAndDownload(txFilteredRows, `transactions_view_export.xlsx`);
    });
    el("txExportCsvBtn").addEventListener("click", async () => {
      applyTxFilters();
      jsonToCsvDownload(txFilteredRows, `transactions_view_export.csv`);
    });

    // Init
    await loadLockedMonths();
    subscribeRecent();
    await refreshMonthlySummary();
    await refreshVendorListDatalist();
    await refreshLockedMonthsUI();
    applyEditModeUI();
    updateLockBadge();
  </script>
