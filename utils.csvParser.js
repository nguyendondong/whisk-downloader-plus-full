// utils.csvParser.js - minimal CSV parser and converter to prompt objects
(function (global) {
  function parseCSV(text) {
    const rows = [];
    let cur = "",
      row = [],
      inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') {
        if (inQuotes && text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        row.push(cur);
        cur = "";
      } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
        if (ch === "\r" && text[i + 1] === "\n") {
          /*skip*/
        }
        row.push(cur);
        cur = "";
        if (row.length === 1 && row[0] === "") {
          row = [];
          continue;
        }
        rows.push(row);
        row = [];
      } else {
        cur += ch;
      }
    }
    if (cur !== "" || row.length > 0) {
      row.push(cur);
      rows.push(row);
    }
    return rows;
  }

  function csvToPromptObjects(text) {
    const rows = parseCSV(text)
      .filter((r) => r.length && r.some((c) => c.trim() !== ""))
      .map((r) => r.map((c) => c.trim()));
    // detect header
    let start = 0;
    if (
      rows.length > 0 &&
      rows[0].some((c) => /scene|context|style|prompt/i.test(c))
    ) {
      start = 1;
    }
    const out = [];
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      if (r.length === 1)
        out.push({ index: i + 1 - start, scene: r[0], context: "", style: "" });
      else if (r.length === 2)
        out.push({
          index: i + 1 - start,
          scene: r[0],
          context: r[1],
          style: "",
        });
      else
        out.push({
          index: i + 1 - start,
          scene: r[0] || "",
          context: r[1] || "",
          style: r[2] || "",
        });
    }
    return out;
  }

  global.CSVPARSER = { parseCSV, csvToPromptObjects };
})(window);
