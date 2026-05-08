const googleSheets = require("../googleSheets");
const { LEGACY_IMPORT_STATUS, parseDryRunParam } = require("./importUtils");

function columnToLetter(columnNumber) {
    let column = columnNumber;
    let letter = "";

    while (column > 0) {
        const remainder = (column - 1) % 26;
        letter = String.fromCharCode(65 + remainder) + letter;
        column = Math.floor((column - 1) / 26);
    }

    return letter;
}

function findOptionalHeaderIndex(headers, headerName) {
    const target = googleSheets.normalizeHeaderName(headerName);
    return headers.findIndex(header => googleSheets.normalizeHeaderName(header) === target);
}

function rowHasAnyValue(row) {
    return Array.isArray(row) && row.some(cell => String(cell || "").trim() !== "");
}

async function handleLegacyLeadStatusCleanup(req, res) {
    const dryRun = parseDryRunParam(req);

    try {
        const { sheets, spreadsheetId } = await googleSheets.createSheetsClient();
        const rows = await googleSheets.readSheet(sheets, spreadsheetId, "LEADS_MAIN!A:ZZ");
        const headers = rows[0] || [];
        const leadStatusIndex = findOptionalHeaderIndex(headers, "lead_status");
        const sourceIndex = findOptionalHeaderIndex(headers, "source");

        if (leadStatusIndex === -1) {
            return res.status(400).json({
                success: false,
                error: "Missing required header: Lead Status",
            });
        }

        let rowsChecked = 0;
        let leadStatusFixed = 0;
        let sourceFixed = 0;
        let skippedUnchanged = 0;
        const batchData = [];
        const sampleItems = [];

        for (let i = 2; i < rows.length; i++) {
            const row = rows[i] || [];
            if (!rowHasAnyValue(row)) continue;

            rowsChecked++;

            const rowNumber = i + 1;
            const currentStatus = String(row[leadStatusIndex] || "").trim();
            const currentSource = sourceIndex === -1 ? "" : String(row[sourceIndex] || "").trim();
            const shouldFixStatus = currentStatus === LEGACY_IMPORT_STATUS;
            const shouldFixSource = shouldFixStatus && sourceIndex !== -1 && !currentSource;

            if (!shouldFixStatus && !shouldFixSource) {
                skippedUnchanged++;
                continue;
            }

            if (shouldFixStatus) {
                leadStatusFixed++;
                batchData.push({
                    range: `LEADS_MAIN!${columnToLetter(leadStatusIndex + 1)}${rowNumber}`,
                    values: [["New"]],
                });
            }

            if (shouldFixSource) {
                sourceFixed++;
                batchData.push({
                    range: `LEADS_MAIN!${columnToLetter(sourceIndex + 1)}${rowNumber}`,
                    values: [[LEGACY_IMPORT_STATUS]],
                });
            }

            if (sampleItems.length < 10) {
                sampleItems.push({
                    row: rowNumber,
                    lead_status_before: currentStatus,
                    lead_status_after: shouldFixStatus ? "New" : currentStatus,
                    source_before: currentSource,
                    source_after: shouldFixSource ? LEGACY_IMPORT_STATUS : currentSource,
                });
            }
        }

        if (!dryRun && batchData.length) {
            await sheets.spreadsheets.values.batchUpdate({
                spreadsheetId,
                requestBody: {
                    valueInputOption: "USER_ENTERED",
                    data: batchData,
                },
            });
        }

        return res.json({
            success: true,
            dry_run: dryRun,
            rows_checked: rowsChecked,
            lead_status_fixed: leadStatusFixed,
            source_fixed: sourceFixed,
            skipped_unchanged: skippedUnchanged,
            sample_items: sampleItems,
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message,
        });
    }
}

module.exports = { handleLegacyLeadStatusCleanup };
