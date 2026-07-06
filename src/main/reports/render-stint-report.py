#!/usr/bin/env python3

"""Render the dashboard's canonical polished landscape stint reports."""
import argparse
import glob
import json
import math
import os
import re
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas

PAGE_W, PAGE_H = landscape(A4)
NAVY = HexColor('#152238')
INK = HexColor('#17201D')
MUTED = HexColor('#68716D')
PAPER = HexColor('#F5F6F2')
PANEL = HexColor('#FFFFFF')
GRID = HexColor('#D8DDD7')
BLUE = HexColor('#2474B5')
GREEN = HexColor('#1F9D70')
YELLOW = HexColor('#E6AD2F')
RED = HexColor('#D94C5F')
ORANGE = HexColor('#D97730')
GRAY = HexColor('#9AA19D')


def fmt_time(ms, decimals=3):
    if ms is None or not isinstance(ms, (int, float)) or not math.isfinite(ms):
        return '-'
    total = abs(ms) / 1000.0
    minutes = int(total // 60)
    seconds = total - minutes * 60
    sign = '-' if ms < 0 else ''
    return f'{sign}{minutes}:{seconds:0{3 + decimals}.{decimals}f}'


def fmt_duration(ms):
    if not isinstance(ms, (int, float)) or not math.isfinite(ms):
        return '-'
    seconds = int(round(ms / 1000))
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)
    return f'{hours}:{minutes:02d}:{seconds:02d}' if hours else f'{minutes}:{seconds:02d}'


def fmt_delta(ms):
    if not isinstance(ms, (int, float)) or not math.isfinite(ms):
        return '-'
    return f'{ms / 1000:+.3f}s'


def safe_name(value):
    cleaned = re.sub(r'[^A-Za-z0-9_-]+', '_', value.strip()).strip('_')
    return cleaned or 'Unknown'


def status_color(status):
    return {
        'valid': BLUE,
        'neutralized': YELLOW,
        'pit-in': RED,
        'pit-out': ORANGE,
        'outlier': GRAY,
    }.get(status, GRAY)


def panel(c, x, y, w, h, title=None):
    c.setFillColor(PANEL)
    c.setStrokeColor(GRID)
    c.setLineWidth(0.8)
    c.roundRect(x, y, w, h, 5, fill=1, stroke=1)
    if title:
        c.setFillColor(MUTED)
        c.setFont('Helvetica-Bold', 7.5)
        c.drawString(x + 10, y + h - 15, title.upper())


def draw_metric(c, x, y, label, value, width=83):
    c.setFillColor(MUTED)
    c.setFont('Helvetica-Bold', 6.8)
    c.drawString(x, y + 14, label.upper())
    c.setFillColor(INK)
    c.setFont('Helvetica-Bold', 12)
    c.drawString(x, y, value)


def draw_chart(c, x, y, w, h, title, laps, value_key, average=None, annotate=True, status_key='status'):
    panel(c, x, y, w, h, title)
    plot_x, plot_y = x + 38, y + 24
    plot_w, plot_h = w - 52, h - 48
    # Excluded samples remain visible in the summary count, but the pace charts
    # contain only comparable values and leave no horizontal gaps between them.
    points = [
        (lap, lap.get(value_key)) for lap in laps
        if lap.get(status_key) == 'valid' and isinstance(lap.get(value_key), (int, float))
    ]
    if not points:
        c.setFillColor(MUTED)
        c.setFont('Helvetica', 9)
        c.drawCentredString(x + w / 2, y + h / 2, 'No valid values')
        return
    values = [value for _, value in points]
    low, high = min(values), max(values)
    padding = max(750, (high - low) * 0.12)
    low, high = low - padding, high + padding
    if high <= low:
        high = low + 1000

    c.setStrokeColor(GRID)
    c.setLineWidth(0.5)
    for index in range(4):
        gy = plot_y + plot_h * index / 3
        c.line(plot_x, gy, plot_x + plot_w, gy)
        label_value = low + (high - low) * index / 3
        c.setFillColor(MUTED)
        c.setFont('Helvetica', 6.5)
        c.drawRightString(plot_x - 5, gy - 2, fmt_time(label_value))

    lap_numbers = [lap.get('lapNumber') or index + 1 for index, (lap, _) in enumerate(points)]
    min_lap, max_lap = min(lap_numbers), max(lap_numbers)
    x_for = lambda index: plot_x + (0.5 if len(points) == 1 else index / (len(points) - 1)) * plot_w
    y_for = lambda value: plot_y + (value - low) / (high - low) * plot_h

    c.setStrokeColor(BLUE)
    c.setLineWidth(1.1)
    last = None
    for index, (lap, value) in enumerate(points):
        px, py = x_for(index), y_for(value)
        if last is not None:
            c.line(last[0], last[1], px, py)
        last = (px, py)
        c.setFillColor(BLUE)
        c.circle(px, py, 2.8, fill=1, stroke=0)

    if isinstance(average, (int, float)) and low <= average <= high:
        ay = y_for(average)
        c.setStrokeColor(GREEN)
        c.setDash(3, 2)
        c.line(plot_x, ay, plot_x + plot_w, ay)
        c.setDash()
        c.setFillColor(GREEN)
        c.setFont('Helvetica-Bold', 6.5)
        c.drawRightString(plot_x + plot_w, ay + 3, f'avg {fmt_time(average)}')

    if annotate and points:
        fastest = min(points, key=lambda item: item[1])
        slowest = max(points, key=lambda item: item[1])
        for label, item, offset in [('FAST', fastest, -10), ('SLOW', slowest, 5)]:
            lap, value = item
            px = x_for(points.index(item))
            py = y_for(value)
            c.setFillColor(GREEN if label == 'FAST' else RED)
            c.setFont('Helvetica-Bold', 6)
            c.drawCentredString(px, py + offset, f'{label} {fmt_time(value)}')

    c.setFillColor(MUTED)
    c.setFont('Helvetica', 6.5)
    c.drawString(plot_x, y + 8, f'Lap {min_lap}')
    c.drawRightString(plot_x + plot_w, y + 8, f'Lap {max_lap}')


def draw_summary(c, x, y, w, h, stint):
    panel(c, x, y, w, h, 'Stint statistics')
    stats = stint['stats']
    best_sectors = [stats.get('bestSector1Ms'), stats.get('bestSector2Ms'), stats.get('bestSector3Ms')]
    ideal_time = sum(best_sectors) if all(isinstance(value, (int, float)) and math.isfinite(value) for value in best_sectors) else None
    metrics = [
        ('Stint time', fmt_duration(stint['stintTimeMs'])),
        ('Total driver', fmt_duration(stint['totalDriverTimeMs'])),
        ('Average lap', fmt_time(stats.get('averageLapMs'))),
        ('Best lap', fmt_time(stats.get('bestLapMs'))),
        ('Valid laps', f"{stats.get('paceLapCount', 0)}/{stats.get('lapCount', 0)}"),
        ('Ideal time', fmt_time(ideal_time)),
        ('Average S1', fmt_time(stats.get('averageSector1Ms'))),
        ('Average S2', fmt_time(stats.get('averageSector2Ms'))),
        ('Average S3', fmt_time(stats.get('averageSector3Ms'))),
    ]
    for index, (label, value) in enumerate(metrics):
        col, row = index % 3, index // 3
        draw_metric(c, x + 12 + col * (w - 24) / 3, y + h - 43 - row * 34, label, value)


def draw_teammates(c, x, y, w, h, stint):
    panel(c, x, y, w, h, 'Comparison with team drivers')
    c.setFont('Helvetica-Bold', 7)
    c.setFillColor(MUTED)
    headers = [('Driver', x + 10), ('Avg', x + w * .48), ('Delta', x + w * .68), ('Best delta', x + w * .84)]
    for text, hx in headers:
        c.drawString(hx, y + h - 31, text)
    yy = y + h - 48
    for teammate in stint.get('teammates', [])[:3]:
        c.setFillColor(INK)
        c.setFont('Helvetica', 7.5)
        c.drawString(x + 10, yy, teammate['driverName'][:24])
        c.drawString(x + w * .48, yy, fmt_time(teammate.get('averageLapMs')))
        c.setFillColor(RED if (teammate.get('averageDeltaMs') or 0) > 0 else GREEN)
        c.drawString(x + w * .68, yy, fmt_delta(teammate.get('averageDeltaMs')))
        c.setFillColor(RED if (teammate.get('bestDeltaMs') or 0) > 0 else GREEN)
        c.drawString(x + w * .84, yy, fmt_delta(teammate.get('bestDeltaMs')))
        yy -= 18
    if not stint.get('teammates'):
        c.setFillColor(MUTED)
        c.setFont('Helvetica', 8)
        c.drawString(x + 10, yy, 'No teammate comparison available')


def draw_gap_panel(c, x, y, w, h, stint):
    panel(c, x, y, w, h, 'Class gap history')
    c.setFillColor(YELLOW)
    c.roundRect(x + 12, y + h - 61, w - 24, 30, 4, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.setFont('Helvetica-Bold', 10)
    c.drawCentredString(x + w / 2, y + h - 50, 'PLANNED FOR PRIORITY 2')
    c.setFillColor(MUTED)
    c.setFont('Helvetica', 7.2)
    lines = [
        'The saved lap-only history does not contain stable,',
        'confirmed class-gap samples. This panel will show',
        'gap evolution once start/finish memory is implemented.'
    ]
    for index, line in enumerate(lines):
        c.drawString(x + 12, y + h - 82 - index * 11, line)


def draw_legend(c, x, y):
    c.setFillColor(BLUE)
    c.circle(x, y, 3, fill=1, stroke=0)
    c.setFillColor(MUTED)
    c.setFont('Helvetica', 6.5)
    c.drawString(x + 6, y - 2, 'Charts show valid samples only; excluded laps remain counted in the summary.')


def summary_card(c, x, y, w, label, value):
    panel(c, x, y, w, 57)
    c.setFillColor(MUTED)
    c.setFont('Helvetica-Bold', 7)
    c.drawString(x + 10, y + 39, label.upper())
    c.setFillColor(INK)
    c.setFont('Helvetica-Bold', 15)
    c.drawString(x + 10, y + 14, value)


def render_race_summary(c, payload):
    race = payload['race']
    summary = payload['raceSummary']
    stats = summary['stats']
    c.setFillColor(PAPER)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.rect(0, PAGE_H - 58, PAGE_W, 58, fill=1, stroke=0)
    c.setFillColor(HexColor('#FFFFFF'))
    c.setFont('Helvetica-Bold', 15)
    c.drawString(28, PAGE_H - 26, race['sessionName'])
    c.setFont('Helvetica', 8)
    c.drawString(28, PAGE_H - 43, f"{race['circuit']}  |  #{race['carNumber']} {race['teamName']}  |  {race['className']}")
    c.setFont('Helvetica-Bold', 14)
    c.drawRightString(PAGE_W - 28, PAGE_H - 27, 'FULL RACE OVERVIEW')

    cards = [
        ('Recorded race time', fmt_duration(summary.get('recordedRaceTimeMs'))),
        ('Completed laps', str(summary.get('totalLaps', 0))),
        ('Valid pace laps', str(stats.get('paceLapCount', 0))),
        ('Best lap', fmt_time(stats.get('bestLapMs'))),
        ('Final PIC', str(summary.get('finalClassPosition') or '-')),
    ]
    card_w = (PAGE_W - 72) / 5
    for index, (label, value) in enumerate(cards):
        summary_card(c, 28 + index * (card_w + 4), 455, card_w, label, value)

    panel(c, 28, 300, 376, 140, 'Full-race pace statistics')
    pace_metrics = [
        ('Average lap', fmt_time(stats.get('averageLapMs'))),
        ('Average S1', fmt_time(stats.get('averageSector1Ms'))),
        ('Average S2', fmt_time(stats.get('averageSector2Ms'))),
        ('Average S3', fmt_time(stats.get('averageSector3Ms'))),
        ('Best S1', fmt_time(stats.get('bestSector1Ms'))),
        ('Best S2', fmt_time(stats.get('bestSector2Ms'))),
        ('Best S3', fmt_time(stats.get('bestSector3Ms'))),
        ('Excluded laps', str(stats.get('selection', {}).get('lap', {}).get('excludedCount', 0))),
    ]
    for index, (label, value) in enumerate(pace_metrics):
        col, row = index % 4, index // 4
        draw_metric(c, 42 + col * 91, 372 - row * 48, label, value, 86)

    panel(c, 416, 300, PAGE_W - 444, 140, 'Pitstops - provider measured L. PIT')
    c.setFillColor(MUTED)
    c.setFont('Helvetica-Bold', 7)
    for text, xx in [('Stop', 430), ('Recorded at', 475), ('Duration', 545), ('Driver change', 620)]:
        c.drawString(xx, 407, text)
    yy = 385
    for stop in summary.get('pitStops', []):
        c.setFillColor(INK)
        c.setFont('Helvetica', 8)
        c.drawString(430, yy, f"#{stop.get('stopNumber')}")
        c.drawString(475, yy, f"Lap {stop.get('lapNumber')}")
        c.setFont('Helvetica-Bold', 8)
        c.drawString(545, yy, fmt_duration(stop.get('durationMs')))
        c.setFont('Helvetica', 6.2)
        before, after = stop.get('driverBefore', ''), stop.get('driverAfter', '')
        change = before if before == after else f'{before} -> {after}'
        c.drawString(620, yy, change[:43])
        yy -= 21
    c.setFillColor(GREEN)
    c.setFont('Helvetica-Bold', 8)
    c.drawString(430, 315, f"{len(summary.get('pitStops', []))} stops  |  total measured pit time {fmt_duration(summary.get('totalPitTimeMs'))}")

    panel(c, 28, 72, 510, 212, 'Driver race comparison')
    headers = [('Driver', 42), ('Laps', 205), ('Valid', 240), ('Average', 275), ('Best', 335), ('Avg S1', 390), ('Avg S2', 440), ('Avg S3', 490)]
    c.setFillColor(MUTED)
    c.setFont('Helvetica-Bold', 7)
    for text, xx in headers:
        c.drawString(xx, 250, text)
    yy = 224
    for driver in summary.get('drivers', []):
        c.setFillColor(INK)
        c.setFont('Helvetica', 7.5)
        values = [
            (42, driver.get('driverName', '')[:27]),
            (205, str(driver.get('lapCount', 0))),
            (240, str(driver.get('paceLapCount', 0))),
            (275, fmt_time(driver.get('averageLapMs'))),
            (335, fmt_time(driver.get('bestLapMs'))),
            (390, fmt_time(driver.get('averageSector1Ms'))),
            (440, fmt_time(driver.get('averageSector2Ms'))),
            (490, fmt_time(driver.get('averageSector3Ms'))),
        ]
        for xx, value in values:
            c.drawString(xx, yy, value)
        yy -= 25

    panel(c, 550, 72, PAGE_W - 578, 212, 'Race control and race facts')
    control = summary.get('raceControl', {})
    facts = [
        ('FCY periods', str(control.get('fcy', 0)), YELLOW),
        ('Safety Car periods', str(control.get('safetyCar', 0)), YELLOW),
        ('Red-flag periods', str(control.get('redFlag', 0)), RED),
        ('Drivers', str(len(summary.get('drivers', []))), BLUE),
        ('Pitstops', str(len(summary.get('pitStops', []))), GREEN),
    ]
    yy = 238
    for label, value, color in facts:
        c.setFillColor(color)
        c.circle(567, yy + 2, 3, fill=1, stroke=0)
        c.setFillColor(MUTED)
        c.setFont('Helvetica-Bold', 7.5)
        c.drawString(578, yy, label)
        c.setFillColor(INK)
        c.setFont('Helvetica-Bold', 11)
        c.drawRightString(PAGE_W - 42, yy - 1, value)
        yy -= 31
    c.setFillColor(MUTED)
    c.setFont('Helvetica', 6.5)
    c.drawRightString(PAGE_W - 28, 18, 'Generated from stored Spa race data | race overview')


def render_page(c, payload, stint, page_number):
    c.setFillColor(PAPER)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.rect(0, PAGE_H - 58, PAGE_W, 58, fill=1, stroke=0)
    race = payload['race']
    c.setFillColor(HexColor('#FFFFFF'))
    c.setFont('Helvetica-Bold', 15)
    c.drawString(28, PAGE_H - 26, race['sessionName'])
    c.setFont('Helvetica', 8)
    c.drawString(28, PAGE_H - 43, f"{race['circuit']}  |  #{race['carNumber']} {race['teamName']}  |  {race['className']}")
    c.setFont('Helvetica-Bold', 14)
    c.drawRightString(PAGE_W - 28, PAGE_H - 27, stint['driverName'])
    c.setFont('Helvetica', 8)
    c.drawRightString(PAGE_W - 28, PAGE_H - 43, f"Stint {stint['stintNumber']}  |  laps {stint['startLap']}-{stint['endLap']}")

    draw_chart(c, 28, 328, PAGE_W - 56, 190, 'Lap times', stint['laps'], 'lapTimeMs', stint['stats'].get('averageLapMs'), True, 'status')
    chart_w = (PAGE_W - 72) / 3
    draw_chart(c, 28, 184, chart_w, 132, 'Sector 1', stint['laps'], 'sector1Ms', stint['stats'].get('averageSector1Ms'), True, 'sector1Status')
    draw_chart(c, 36 + chart_w, 184, chart_w, 132, 'Sector 2', stint['laps'], 'sector2Ms', stint['stats'].get('averageSector2Ms'), True, 'sector2Status')
    draw_chart(c, 44 + chart_w * 2, 184, chart_w, 132, 'Sector 3', stint['laps'], 'sector3Ms', stint['stats'].get('averageSector3Ms'), True, 'sector3Status')

    bottom_w = (PAGE_W - 72) / 3
    draw_summary(c, 28, 34, bottom_w, 138, stint)
    draw_teammates(c, 36 + bottom_w, 34, bottom_w, 138, stint)
    draw_gap_panel(c, 44 + bottom_w * 2, 34, bottom_w, 138, stint)
    draw_legend(c, 35, 19)
    c.setFillColor(MUTED)
    c.setFont('Helvetica', 6.5)
    c.drawRightString(PAGE_W - 28, 18, f'Generated from stored Spa race data | page {page_number}')


def render_pdf(filename, payload, stints, include_summary=False):
    pdf = canvas.Canvas(filename, pagesize=(PAGE_W, PAGE_H))
    pdf.setTitle(f"{payload['race']['sessionName']} stint analysis")
    if include_summary:
        render_race_summary(pdf, payload)
        pdf.showPage()
    for index, stint in enumerate(stints, 1):
        render_page(pdf, payload, stint, index)
        pdf.showPage()
    pdf.save()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument(
        '--single-output',
        help='Render the supplied stints into one exact output path instead of creating the full report set.',
    )
    parser.add_argument(
        '--include-summary',
        action='store_true',
        help='Add the full-race overview as the first page when --single-output is used.',
    )
    args = parser.parse_args()
    with open(args.input, encoding='utf-8') as handle:
        payload = json.load(handle)
    os.makedirs(args.output, exist_ok=True)
    car = payload['race']['carNumber']
    if args.single_output:
        os.makedirs(os.path.dirname(os.path.abspath(args.single_output)), exist_ok=True)
        render_pdf(args.single_output, payload, payload['stints'], include_summary=args.include_summary)
        return
    # Prevent stale stint pages from remaining when corrected driver boundaries
    # reduce or increase the number of generated stints.
    for old_report in glob.glob(os.path.join(args.output, 'STINT_*.pdf')):
        os.remove(old_report)
    render_pdf(os.path.join(args.output, f'RACE_OVERVIEW_CAR_{car}.pdf'), payload, [], include_summary=True)
    render_pdf(os.path.join(args.output, f'SPA_RACE_CAR_{car}_ALL_STINTS.pdf'), payload, payload['stints'], include_summary=True)
    for stint in payload['stints']:
        filename = f"STINT_{stint['stintNumber']}_{safe_name(stint['driverName'])}.pdf"
        render_pdf(os.path.join(args.output, filename), payload, [stint])


if __name__ == '__main__':
    main()
