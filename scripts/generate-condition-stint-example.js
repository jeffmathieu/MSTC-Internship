#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { buildConditionExamplePayload } = require('../tests/fixtures/conditionStintExample');
const { renderReportLabPdf, findPdfPython } = require('../src/main/stintReports');

function main() {
  const outputDir = path.join(__dirname, '..', 'output', 'pdf');
  fs.mkdirSync(outputDir, { recursive: true });
  const payload = buildConditionExamplePayload();
  const jsonPath = path.join(outputDir, 'CONDITION_STINT_EXAMPLE.json');
  const pdfPath = path.join(outputDir, 'CONDITION_STINT_EXAMPLE.pdf');
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  const python = findPdfPython();
  if (!python) {
    throw new Error('No Python interpreter with ReportLab was found. Install reportlab or set PDF_PYTHON.');
  }
  const result = renderReportLabPdf(jsonPath, pdfPath, { python });
  if (!result.rendered) {
    throw new Error(result.error || result.reason || 'Condition stint PDF render failed.');
  }
  console.log(`Wrote ${pdfPath}`);
}

if (require.main === module) main();
