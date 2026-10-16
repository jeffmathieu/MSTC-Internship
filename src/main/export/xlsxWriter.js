// Small dependency-free .xlsx writer: formatted sheets with frozen headers and
// filters, plus native Excel charts (line, column, pie) whose data is cached so
// they also render in viewers that do not recalculate (e.g. Protected View).
const { createZip } = require('./zipWriter');

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_CHART = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_SPREADSHEET_DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const PALETTE = ['2474B5', 'D94C5F', '1F9D70', 'E6AD2F', '7651B5', '2A9DB0', 'D97730', '9AA19D'];

// Style names -> cellXfs index (see styles()).
const STYLES = { default: 0, header: 1, lapTime: 2, duration: 3, int: 4, dec3: 5, dateTime: 6, percent: 7, wrap: 8, bold: 9, delta: 10, title: 11, clock: 12 };

const esc = (value) => String(value ?? '')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

const DAY_MS = 86400000;
// Excel stores times as fractions of a day and dates as serial numbers.
const excel = {
  duration: (ms) => (Number.isFinite(ms) ? ms / DAY_MS : null),
  dateTime: (iso) => {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return null;
    // Show local clock time, as the dashboard does.
    return (at - new Date(at).getTimezoneOffset() * 60000) / DAY_MS + 25569;
  }
};

function safeSheetName(name, used) {
  let base = String(name).replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) candidate = `${base.slice(0, 28)} ${n}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

class Sheet {
  constructor(name) {
    this.name = name;
    this.header = null;
    this.columns = [];
    this.rows = [];
    this.freezeHeader = false;
    this.filter = false;
    this.charts = [];
  }

  cellXml(row, col, value, columnStyle) {
    let style = columnStyle;
    let v = value;
    if (v && typeof v === 'object' && !Array.isArray(v)) { style = v.style ?? style; v = v.v; }
    if (v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v))) return '';
    const ref = `${columnName(col)}${row}`;
    const s = STYLES[style] ? ` s="${STYLES[style]}"` : '';
    if (typeof v === 'number') return `<c r="${ref}"${s}><v>${v}</v></c>`;
    if (typeof v === 'boolean') return `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  }

  xml(selected, hasDrawing) {
    const columnCount = Math.max(this.header?.length || 0, this.columns.length, ...this.rows.map((row) => row.length), 1);
    const lines = [];
    let rowNumber = 0;
    if (this.header) {
      rowNumber += 1;
      lines.push(`<row r="${rowNumber}" ht="20" customHeight="1">${this.header.map((label, c) => this.cellXml(rowNumber, c, label, 'header')).join('')}</row>`);
    }
    this.rows.forEach((row) => {
      rowNumber += 1;
      lines.push(`<row r="${rowNumber}">${row.map((value, c) => this.cellXml(rowNumber, c, value, this.columns[c]?.style)).join('')}</row>`);
    });
    const cols = this.columns.some((column) => column?.width)
      ? `<cols>${Array.from({ length: columnCount }, (_, c) => `<col min="${c + 1}" max="${c + 1}" width="${this.columns[c]?.width || 12}" customWidth="1"/>`).join('')}</cols>`
      : '';
    const pane = this.freezeHeader && this.header
      ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : '';
    const autoFilter = this.filter && this.header && rowNumber > 1 ? `<autoFilter ref="A1:${columnName(columnCount - 1)}${rowNumber}"/>` : '';
    return `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
      + `<sheetViews><sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews>`
      + `<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${lines.join('')}</sheetData>${autoFilter}`
      + `${hasDrawing ? '<drawing r:id="rId1"/>' : ''}</worksheet>`;
  }
}

function sheetRef(sheetName, column, first, last) {
  return `'${sheetName.replace(/'/g, "''")}'!$${column}$${first}:$${column}$${last}`;
}

function textBlock(text, size) {
  return `<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="1"/></a:pPr><a:r><a:rPr lang="en-US" sz="${size}" b="1"/><a:t>${esc(text)}</a:t></a:r></a:p></c:rich></c:tx>`;
}

function titleXml(text, size = 1200) {
  return text ? `<c:title>${textBlock(text, size)}<c:overlay val="0"/></c:title>` : '';
}

function numCache(values, format) {
  const points = values.map((value, i) => (Number.isFinite(value) ? `<c:pt idx="${i}"><c:v>${value}</c:v></c:pt>` : '')).join('');
  return `<c:numCache><c:formatCode>${esc(format || 'General')}</c:formatCode><c:ptCount val="${values.length}"/>${points}</c:numCache>`;
}

function strCache(values) {
  return `<c:strCache><c:ptCount val="${values.length}"/>${values.map((value, i) => `<c:pt idx="${i}"><c:v>${esc(value)}</c:v></c:pt>`).join('')}</c:strCache>`;
}

function dataRef(range, tag) {
  const f = `<c:f>${esc(sheetRef(range.sheet, range.column, range.first, range.last))}</c:f>`;
  if (range.kind === 'str') return `<c:${tag}><c:strRef>${f}${strCache(range.values)}</c:strRef></c:${tag}>`;
  return `<c:${tag}><c:numRef>${f}${numCache(range.values, range.format)}</c:numRef></c:${tag}>`;
}

function fill(color) { return `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`; }

function seriesXml(chart, series, index) {
  const color = series.color || PALETTE[index % PALETTE.length];
  const tx = `<c:tx><c:v>${esc(series.name)}</c:v></c:tx>`;
  const head = `<c:idx val="${index}"/><c:order val="${index}"/>${tx}`;
  if (chart.type === 'line') {
    return `<c:ser>${head}<c:spPr><a:ln w="15875" cap="rnd">${fill(color)}<a:round/></a:ln></c:spPr>`
      + `<c:marker><c:symbol val="circle"/><c:size val="3"/><c:spPr>${fill(color)}<a:ln w="6350">${fill(color)}</a:ln></c:spPr></c:marker>`
      + `${dataRef(series.cat, 'cat')}${dataRef(series.val, 'val')}<c:smooth val="0"/></c:ser>`;
  }
  if (chart.type === 'pie') {
    const points = series.cat.values.map((_, i) => `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr>${fill(PALETTE[i % PALETTE.length])}<a:ln w="9525"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`).join('');
    return `<c:ser>${head}${points}<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="0"/></c:dLbls>`
      + `${dataRef(series.cat, 'cat')}${dataRef(series.val, 'val')}</c:ser>`;
  }
  return `<c:ser>${head}<c:spPr>${fill(color)}</c:spPr><c:invertIfNegative val="0"/>${dataRef(series.cat, 'cat')}${dataRef(series.val, 'val')}</c:ser>`;
}

function axisXml(chart) {
  const reverse = chart.reverseValueAxis ? 'maxMin' : 'minMax';
  const bounds = `${Number.isFinite(chart.valueMax) ? `<c:max val="${chart.valueMax}"/>` : ''}${Number.isFinite(chart.valueMin) ? `<c:min val="${chart.valueMin}"/>` : ''}`;
  return `<c:catAx><c:axId val="500100"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${titleXml(chart.categoryTitle, 900)}`
    + `<c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="${chart.reverseValueAxis ? 'high' : 'low'}"/>`
    + `<c:crossAx val="500200"/><c:crosses val="${chart.reverseValueAxis ? 'max' : 'autoZero'}"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
    + `<c:valAx><c:axId val="500200"/><c:scaling><c:orientation val="${reverse}"/>${bounds}</c:scaling><c:delete val="0"/><c:axPos val="l"/>`
    + `<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="D8DDD7"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>${titleXml(chart.valueTitle, 900)}`
    + `<c:numFmt formatCode="${esc(chart.valueFormat || 'General')}" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>`
    + '<c:crossAx val="500100"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>';
}

function chartXml(chart) {
  const sers = chart.series.map((series, index) => seriesXml(chart, series, index)).join('');
  let plot;
  if (chart.type === 'pie') plot = `<c:pieChart><c:varyColors val="1"/>${sers}<c:firstSliceAng val="0"/></c:pieChart>`;
  else if (chart.type === 'line') plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers}<c:marker val="1"/><c:axId val="500100"/><c:axId val="500200"/></c:lineChart>${axisXml(chart)}`;
  else plot = `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${sers}<c:gapWidth val="80"/><c:axId val="500100"/><c:axId val="500200"/></c:barChart>${axisXml(chart)}`;
  const legend = chart.series.length > 1 || chart.type === 'pie' ? '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>' : '';
  return `${XML_HEAD}<c:chartSpace xmlns:c="${NS_CHART}" xmlns:a="${NS_DRAWING}" xmlns:r="${NS_REL}"><c:roundedCorners val="0"/>`
    + `<c:chart>${titleXml(chart.title)}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

function drawingXml(charts) {
  const anchors = charts.map((chart, index) => {
    const { col, row, cols, rows } = chart.anchor;
    return `<xdr:twoCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
      + `<xdr:to><xdr:col>${col + cols}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + rows}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`
      + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${index + 2}" name="${esc(chart.title || `Chart ${index + 1}`)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`
      + '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
      + `<c:chart xmlns:c="${NS_CHART}" xmlns:r="${NS_REL}" r:id="rId${index + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  }).join('');
  return `${XML_HEAD}<xdr:wsDr xmlns:xdr="${NS_SPREADSHEET_DRAWING}" xmlns:a="${NS_DRAWING}">${anchors}</xdr:wsDr>`;
}

function stylesXml() {
  const xf = (numFmtId, fontId = 0, fillId = 0, extra = '', alignment = '') =>
    `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${alignment ? ' applyAlignment="1"' : ''}${extra}${alignment ? `>${alignment}</xf>` : '/>'}`;
  return `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">`
    + '<numFmts count="7"><numFmt numFmtId="164" formatCode="m:ss.000"/><numFmt numFmtId="165" formatCode="[h]:mm:ss"/><numFmt numFmtId="166" formatCode="yyyy-mm-dd hh:mm:ss"/>'
    + '<numFmt numFmtId="167" formatCode="0.0%"/><numFmt numFmtId="168" formatCode="+0.000;-0.000;0.000"/><numFmt numFmtId="169" formatCode="0.000"/><numFmt numFmtId="170" formatCode="hh:mm:ss"/></numFmts>'
    + '<fonts count="4"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
    + '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>'
    + '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
    + '<font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FF152238"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="13">${[
      xf(0),
      xf(0, 1, 2, '', '<alignment horizontal="center" vertical="center" wrapText="1"/>'),
      xf(164), xf(165), xf(1), xf(169), xf(166), xf(167),
      xf(0, 0, 0, '', '<alignment vertical="top" wrapText="1"/>'),
      xf(0, 2), xf(168), xf(0, 3), xf(170)
    ].join('')}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
}

class Workbook {
  constructor() {
    this.sheets = [];
    this.usedNames = new Set();
  }

  addSheet(name) {
    const sheet = new Sheet(safeSheetName(name, this.usedNames));
    this.sheets.push(sheet);
    return sheet;
  }

  toBuffer() {
    const entries = [];
    const overrides = [];
    const workbookRels = [];
    const sheetEntries = [];
    let chartCount = 0;
    let drawingCount = 0;
    this.sheets.forEach((sheet, index) => {
      const n = index + 1;
      const hasDrawing = sheet.charts.length > 0;
      sheetEntries.push(`<sheet name="${esc(sheet.name)}" sheetId="${n}" r:id="rId${n}"/>`);
      workbookRels.push(`<Relationship Id="rId${n}" Type="${REL}/worksheet" Target="worksheets/sheet${n}.xml"/>`);
      overrides.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
      entries.push({ name: `xl/worksheets/sheet${n}.xml`, data: sheet.xml(index === 0, hasDrawing) });
      if (!hasDrawing) return;
      drawingCount += 1;
      entries.push({ name: `xl/worksheets/_rels/sheet${n}.xml.rels`,
        data: `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing${drawingCount}.xml"/></Relationships>` });
      entries.push({ name: `xl/drawings/drawing${drawingCount}.xml`, data: drawingXml(sheet.charts) });
      overrides.push(`<Override PartName="/xl/drawings/drawing${drawingCount}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
      const rels = sheet.charts.map((chart, chartIndex) => {
        chartCount += 1;
        entries.push({ name: `xl/charts/chart${chartCount}.xml`, data: chartXml(chart) });
        overrides.push(`<Override PartName="/xl/charts/chart${chartCount}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
        return `<Relationship Id="rId${chartIndex + 1}" Type="${REL}/chart" Target="../charts/chart${chartCount}.xml"/>`;
      });
      entries.push({ name: `xl/drawings/_rels/drawing${drawingCount}.xml.rels`, data: `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">${rels.join('')}</Relationships>` });
    });
    const stylesId = this.sheets.length + 1;
    workbookRels.push(`<Relationship Id="rId${stylesId}" Type="${REL}/styles" Target="styles.xml"/>`);
    entries.unshift(
      { name: '[Content_Types].xml', data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides.join('')}</Types>` },
      { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: 'xl/workbook.xml', data: `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheetEntries.join('')}</sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', data: `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">${workbookRels.join('')}</Relationships>` },
      { name: 'xl/styles.xml', data: stylesXml() }
    );
    return createZip(entries);
  }
}

module.exports = { Workbook, columnName, excel, STYLES, PALETTE };
