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
MINOR_GRID = HexColor("#A3A3A3C8")
BLUE = HexColor('#2474B5')
GREEN = HexColor('#1F9D70')
YELLOW = HexColor('#E6AD2F')
RED = HexColor('#D94C5F')
ORANGE = HexColor('#D97730')
GRAY = HexColor('#9AA19D')
WET = HexColor('#2A9DB0')
TRANSITION = HexColor('#D97730')
POINT_RADIUS = 1.5
CONDITION_RING_RADIUS = 2.6


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


def fmt_gap(ms, decimals=3):
    if ms is None or not isinstance(ms, (int, float)) or not math.isfinite(ms):
        return '-'
    seconds = abs(ms) / 1000.0
    if seconds < 60:
        return f'{seconds:.{decimals}f}s'
    return fmt_time(ms, decimals)


def safe_name(value):
    cleaned = re.sub(r'[^A-Za-z0-9_-]+', '_', value.strip()).strip('_')
    return cleaned or 'Unknown'


def race_detail_line(race):
    details = [
        race.get('circuit'),
        f"#{race.get('carNumber', '')} {race.get('teamName', '')}".strip(),
        race.get('className'),
    ]
    return '  |  '.join(str(value) for value in details if value)


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

    # Major grid lines keep the strong rhythm. Minor dashed lines between them
    # add extra time references without making the charts visually heavy.
    for index in range(7):
        is_major = index % 2 == 0
        gy = plot_y + plot_h * index / 6
        label_value = low + (high - low) * index / 6
        c.setStrokeColor(GRID if is_major else MINOR_GRID)
        c.setLineWidth(0.5 if is_major else 0.35)
        if not is_major:
            c.setDash(1.2, 2.2)
        c.line(plot_x, gy, plot_x + plot_w, gy)
        c.setDash()
        c.setFillColor(MUTED)
        c.setFont('Helvetica', 6.5 if is_major else 5.6)
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
            # Condition rings change the canvas stroke color. Reset the pace
            # line before every segment so wet/transition markers never tint
            # the following line section.
            c.setStrokeColor(BLUE)
            c.setLineWidth(1.1)
            c.line(last[0], last[1], px, py)
        last = (px, py)
        c.setFillColor(BLUE)
        c.circle(px, py, POINT_RADIUS, fill=1, stroke=0)
        condition_key = 'lapCondition' if value_key == 'lapTimeMs' else value_key.replace('Ms', 'Condition')
        condition = lap.get(condition_key, 'unknown')
        if condition in ('wet', 'transition'):
            c.setStrokeColor(WET if condition == 'wet' else TRANSITION)
            c.setLineWidth(0.75)
            c.circle(px, py, CONDITION_RING_RADIUS, fill=0, stroke=1)

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
    by_condition = stint.get('statsByCondition') or {}
    condition_parts = []
    for condition, label in (('dry', 'Dry'), ('wet', 'Wet')):
        condition_stats = by_condition.get(condition) or {}
        if condition_stats.get('paceLapCount', 0):
            condition_parts.append(f"{label} {fmt_time(condition_stats.get('averageLapMs'))} ({condition_stats.get('paceLapCount')})")
    if condition_parts:
        c.setFillColor(MUTED)
        c.setFont('Helvetica', 5.5)
        c.drawRightString(x + w - 10, y + h - 15, ' | '.join(condition_parts))
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


def draw_comparisons(c, x, y, w, h, stint):
    panel(c, x, y, w, h, 'Team and class comparison')
    c.setFont('Helvetica-Bold', 7)
    c.setFillColor(MUTED)
    headers = [('Target', x + 10), ('Avg', x + w * .49), ('Delta', x + w * .69), ('Best D', x + w * .85)]
    for text, hx in headers:
        c.drawString(hx, y + h - 31, text)
    yy = y + h - 44

    def draw_row(label, item, row_y):
        c.setFillColor(INK)
        c.setFont('Helvetica', 6.2)
        c.drawString(x + 10, row_y, label[:27])
        c.drawString(x + w * .49, row_y, fmt_time(item.get('averageLapMs')))
        c.setFillColor(RED if (item.get('averageDeltaMs') or 0) > 0 else GREEN)
        c.drawString(x + w * .69, row_y, fmt_delta(item.get('averageDeltaMs')))
        c.setFillColor(RED if (item.get('bestDeltaMs') or 0) > 0 else GREEN)
        c.drawString(x + w * .85, row_y, fmt_delta(item.get('bestDeltaMs')))

    c.setFillColor(MUTED)
    c.setFont('Helvetica-Bold', 5.8)
    c.drawString(x + 10, yy, 'TEAM')
    yy -= 12
    for teammate in stint.get('teammates', [])[:2]:
        draw_row(teammate.get('driverName', ''), teammate, yy)
        yy -= 13
    if not stint.get('teammates'):
        c.setFillColor(MUTED)
        c.setFont('Helvetica', 6)
        c.drawString(x + 10, yy, 'No teammate comparison')
        yy -= 13

    c.setFillColor(MUTED)
    c.setFont('Helvetica-Bold', 5.8)
    c.drawString(x + 10, yy, 'CLASS DURING THIS STINT')
    yy -= 12
    for rival in stint.get('classComparisons', [])[:4]:
        label = f"#{rival.get('carNumber', '?')} {rival.get('teamName', '')}"
        draw_row(label, rival, yy)
        yy -= 13
    if not stint.get('classComparisons'):
        c.setFillColor(MUTED)
        c.setFont('Helvetica', 6)
        c.drawString(x + 10, yy, 'No same-window class laps')


def draw_insights(c, x, y, w, h, stint):
    panel(c, x, y, w, h, 'Stint engineering insights')
    data = stint.get('insights') or {}
    consistency = data.get('consistency') or {}
    phases = data.get('stintPhases') or {}
    class_ranking = data.get('classRanking') or {}
    compliance = data.get('compliance') or {}

    def signed_rate(value):
        return f'{value / 1000:+.3f}s/lap' if isinstance(value, (int, float)) and math.isfinite(value) else '-'

    def compliance_text(key):
        item = compliance.get(key) or {}
        return 'OK (not set)' if item.get('known') is False else item.get('label') or '-'

    phase_text = ' / '.join(fmt_time(phases.get(key)) for key in ('firstMs', 'middleMs', 'finalMs'))
    def rank_text(key):
        item = class_ranking.get(key) or {}
        if not item.get('rank') or not item.get('total'):
            return '-'
        leader = item.get('leaderCarNumber')
        suffix = f" | {fmt_delta(item.get('deltaToLeaderMs'))} vs #{leader}" if leader and leader != 'our car' else ' | class benchmark'
        return f"{item.get('rank')}/{item.get('total')}{suffix}"
    left = [
        ('Consistency*', f"{fmt_gap(consistency.get('standardDeviationMs'))} | {consistency.get('coefficientPercent', 0):.2f}%" if isinstance(consistency.get('coefficientPercent'), (int, float)) else '-'),
        ('Pace trend', signed_rate(data.get('paceTrendMsPerLap'))),
        ('Best theoretical', fmt_time(data.get('bestTheoreticalLapMs'))),
        ('Average theoretical', fmt_time(data.get('averageTheoreticalLapMs'))),
    ]
    right = [
        ('Class average rank', rank_text('average')),
        ('Class best-lap rank', rank_text('best')),
        ('Stint phases F/M/L', phase_text),
        ('First 5 vs last 5', f"{fmt_time(data.get('firstFiveMs'))} / {fmt_time(data.get('lastFiveMs'))} | {fmt_delta(data.get('firstVsLastFiveDeltaMs'))}"),
    ]

    c.setFillColor(MUTED)
    c.setFont('Helvetica-Bold', 4.9)
    c.drawString(x + 10, y + h - 30, 'COACHING SUMMARY')
    yy = y + h - 39
    c.setFont('Helvetica', 5.6)
    c.setFillColor(INK)
    for line in (data.get('coachingSummary') or ['No coaching summary available.'])[:3]:
        c.drawString(x + 10, yy, str(line)[:82])
        yy -= 8

    def draw_column(items, xx, width):
        yy = y + h - 69
        for label, value in items:
            c.setFillColor(MUTED)
            c.setFont('Helvetica-Bold', 4.8)
            c.drawString(xx, yy, label.upper())
            c.setFillColor(INK)
            c.setFont('Helvetica-Bold', 6.1)
            c.drawString(xx, yy - 8, str(value)[:31])
            yy -= 18

    draw_column(left, x + 10, w * .49 - 14)
    draw_column(right, x + w * .51, w * .47 - 10)


def draw_legend(c, x, y):
    c.setFillColor(BLUE)
    c.circle(x, y, 3, fill=1, stroke=0)
    c.setFillColor(MUTED)
    c.setFont('Helvetica', 6.5)
    c.drawString(x + 6, y - 2, 'Valid samples only; rings:')
    c.setStrokeColor(WET)
    c.setLineWidth(1.2)
    c.circle(x + 94, y, 4, fill=0, stroke=1)
    c.setFillColor(MUTED)
    c.drawString(x + 103, y - 2, 'wet')
    c.setStrokeColor(TRANSITION)
    c.circle(x + 136, y, 4, fill=0, stroke=1)
    c.setFillColor(MUTED)
    c.drawString(x + 145, y - 2, 'transition; excluded laps remain counted.')


def draw_consistency_note(c, x, y):
    """Explain the consistency metric directly below the engineering-insights panel."""
    c.setFillColor(MUTED)
    c.setFont('Helvetica', 5.2)
    c.drawString(x, y, '* Consistency = standard deviation of valid lap times;')
    c.drawString(x, y - 7, 'a lower value means more consistent pace.')


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
    left_x = 28
    pit_x = PAGE_W - 226
    pit_w = PAGE_W - pit_x - 28
    left_w = pit_x - left_x - 12
    pit_y = 72
    pit_h = 440

    def finite_values(values):
        return [value for value in values if isinstance(value, (int, float)) and math.isfinite(value)]

    def average_ms(values):
        usable = finite_values(values)
        return sum(usable) / len(usable) if usable else None

    def metric_or_dash(*values):
        usable = finite_values(values)
        return sum(usable) if len(usable) == len(values) else None

    c.setFillColor(PAPER)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.rect(0, PAGE_H - 58, PAGE_W, 58, fill=1, stroke=0)
    c.setFillColor(HexColor('#FFFFFF'))
    c.setFont('Helvetica-Bold', 15)
    c.drawString(28, PAGE_H - 26, race['sessionName'])
    c.setFont('Helvetica', 8)
    c.drawString(28, PAGE_H - 43, race_detail_line(race))
    c.setFont('Helvetica-Bold', 14)
    c.drawRightString(PAGE_W - 28, PAGE_H - 27, 'FULL RACE OVERVIEW')

    cards = [
        ('Recorded race time', fmt_duration(summary.get('recordedRaceTimeMs'))),
        ('Completed laps', str(summary.get('totalLaps', 0))),
        ('Valid pace laps', str(stats.get('paceLapCount', 0))),
        ('Best lap', fmt_time(stats.get('bestLapMs'))),
        ('Final PIC', str(summary.get('finalClassPosition') or '-')),
    ]
    card_w = (left_w - 16) / 5
    for index, (label, value) in enumerate(cards):
        summary_card(c, left_x + index * (card_w + 4), 455, card_w, label, value)

    pace_w = 342
    condition_w = left_w - pace_w - 8
    panel(c, left_x, 300, pace_w, 140, 'Full-race pace statistics')
    best_theoretical_ms = metric_or_dash(stats.get('bestSector1Ms'), stats.get('bestSector2Ms'), stats.get('bestSector3Ms'))
    average_theoretical_ms = metric_or_dash(stats.get('averageSector1Ms'), stats.get('averageSector2Ms'), stats.get('averageSector3Ms'))
    pace_metrics = [
        ('Average lap', fmt_time(stats.get('averageLapMs'))),
        ('Average S1', fmt_time(stats.get('averageSector1Ms'))),
        ('Average S2', fmt_time(stats.get('averageSector2Ms'))),
        ('Average S3', fmt_time(stats.get('averageSector3Ms'))),
        ('Best S1', fmt_time(stats.get('bestSector1Ms'))),
        ('Best S2', fmt_time(stats.get('bestSector2Ms'))),
        ('Best S3', fmt_time(stats.get('bestSector3Ms'))),
        ('Ideal best', fmt_time(best_theoretical_ms)),
        ('Ideal avg', fmt_time(average_theoretical_ms)),
        ('Excluded', str(stats.get('selection', {}).get('lap', {}).get('excludedCount', 0))),
    ]
    for index, (label, value) in enumerate(pace_metrics):
        col, row = index % 5, index // 5
        draw_metric(c, left_x + 13 + col * 65, 372 - row * 48, label, value, 60)

    panel(c, left_x + pace_w + 8, 300, condition_w, 140, 'Condition pace breakdown')
    by_condition = summary.get('statsByCondition') or {}
    condition_rows = [
        ('Combined', by_condition.get('combined') or stats),
        ('Dry', by_condition.get('dry') or {}),
        ('Wet', by_condition.get('wet') or {}),
        ('Intermediate', by_condition.get('transition') or {}),
    ]
    c.setFillColor(MUTED)
    c.setFont('Helvetica-Bold', 6.5)
    for text, xx in [('Mode', left_x + pace_w + 22), ('Laps', left_x + pace_w + 92), ('Average', left_x + pace_w + 129), ('Best', left_x + pace_w + 192)]:
        c.drawString(xx, 406, text)
    yy = 386
    for label, condition_stats in condition_rows:
        pace_laps = condition_stats.get('paceLapCount', 0)
        c.setFillColor(INK)
        c.setFont('Helvetica-Bold' if label == 'Combined' else 'Helvetica', 7)
        c.drawString(left_x + pace_w + 22, yy, label)
        c.drawRightString(left_x + pace_w + 111, yy, str(condition_stats.get('lapCount', 0)))
        c.drawString(left_x + pace_w + 129, yy, fmt_time(condition_stats.get('averageLapMs')) if pace_laps else '-')
        c.drawString(left_x + pace_w + 192, yy, fmt_time(condition_stats.get('bestLapMs')) if pace_laps else '-')
        yy -= 20
    c.setFillColor(MUTED)
    c.setFont('Helvetica', 5.7)

    panel(c, pit_x, pit_y, pit_w, pit_h, 'Pitstops - provider measured L. PIT')
    pit_stops = summary.get('pitStops', [])
    c.setFillColor(MUTED)
    c.setFont('Helvetica-Bold', 6.2)
    header_y = pit_y + pit_h - 36
    for text, xx in [('Stop', pit_x + 12), ('Lap', pit_x + 42), ('Dur.', pit_x + 75), ('Driver change', pit_x + 112)]:
        c.drawString(xx, header_y, text)
    available_h = pit_h - 76
    row_h = min(13, max(7.5, available_h / max(len(pit_stops), 1)))
    row_font = 6.5 if row_h >= 9 else 5.4
    yy = header_y - 18
    for stop in pit_stops:
        c.setFillColor(INK)
        c.setFont('Helvetica', row_font)
        c.drawString(pit_x + 12, yy, f"#{stop.get('stopNumber')}")
        c.drawString(pit_x + 42, yy, str(stop.get('lapNumber') or '-'))
        c.setFont('Helvetica-Bold', row_font)
        c.drawString(pit_x + 75, yy, fmt_duration(stop.get('durationMs')))
        c.setFont('Helvetica', max(4.8, row_font - 0.8))
        before, after = stop.get('driverBefore', ''), stop.get('driverAfter', '')
        change = before if before == after else f'{before} -> {after}'
        c.drawString(pit_x + 112, yy, change[:27])
        yy -= row_h
        if yy < pit_y + 37:
            c.setFillColor(MUTED)
            c.setFont('Helvetica-Bold', 5.5)
            remaining = max(0, len(pit_stops) - stop.get('stopNumber', len(pit_stops)))
            if remaining:
                c.drawString(pit_x + 12, yy, f'+ {remaining} more stops in source data')
            break
    pit_durations = finite_values([stop.get('durationMs') for stop in pit_stops])
    c.setFillColor(GREEN)
    c.setFont('Helvetica-Bold', 6.5)
    c.drawString(pit_x + 12, pit_y + 19, f"{len(pit_stops)} stops | total {fmt_duration(summary.get('totalPitTimeMs'))} | avg {fmt_duration(average_ms(pit_durations))}")

    panel(c, left_x, 118, left_w, 170, 'Driver race comparison')
    headers = [('Driver', left_x + 14), ('Laps', left_x + 188), ('Valid', left_x + 226), ('Average', left_x + 265), ('Best', left_x + 325), ('Avg S1', left_x + 380), ('Avg S2', left_x + 430), ('Avg S3', left_x + 480)]
    c.setFillColor(MUTED)
    c.setFont('Helvetica-Bold', 7)
    for text, xx in headers:
        c.drawString(xx, 254, text)
    yy = 228
    for driver in summary.get('drivers', []):
        c.setFillColor(INK)
        c.setFont('Helvetica', 7.5)
        values = [
            (left_x + 14, driver.get('driverName', '')[:27]),
            (left_x + 188, str(driver.get('lapCount', 0))),
            (left_x + 226, str(driver.get('paceLapCount', 0))),
            (left_x + 265, fmt_time(driver.get('averageLapMs'))),
            (left_x + 325, fmt_time(driver.get('bestLapMs'))),
            (left_x + 380, fmt_time(driver.get('averageSector1Ms'))),
            (left_x + 430, fmt_time(driver.get('averageSector2Ms'))),
            (left_x + 480, fmt_time(driver.get('averageSector3Ms'))),
        ]
        for xx, value in values:
            c.drawString(xx, yy, value)
        yy -= 22

    panel(c, left_x, 72, left_w, 34, 'Race control')
    control = summary.get('raceControl', {})
    facts = [
        ('FCY', str(control.get('fcy', 0)), YELLOW),
        ('SC', str(control.get('safetyCar', 0)), YELLOW),
        ('Red', str(control.get('redFlag', 0)), RED),
    ]
    xx = left_x + 14
    for label, value, color in facts:
        c.setFillColor(color)
        c.circle(xx, 86, 2.6, fill=1, stroke=0)
        c.setFillColor(MUTED)
        c.setFont('Helvetica-Bold', 6.6)
        c.drawString(xx + 8, 84, label)
        c.setFillColor(INK)
        c.setFont('Helvetica-Bold', 8)
        c.drawString(xx + 35, 84, value)
        xx += 78
    c.setFillColor(MUTED)
    c.setFont('Helvetica', 6.5)
    c.drawRightString(PAGE_W - 28, 18, 'Generated from stored race data | race overview')


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
    c.drawString(28, PAGE_H - 43, race_detail_line(race))
    c.setFont('Helvetica-Bold', 14)
    c.drawRightString(PAGE_W - 28, PAGE_H - 27, stint['driverName'])
    c.setFont('Helvetica', 8)
    laps = stint.get('laps', [])
    start_lap = stint.get('startLap') if stint.get('startLap') is not None else (laps[0].get('lapNumber') if laps else '-')
    end_lap = stint.get('endLap') if stint.get('endLap') is not None else (laps[-1].get('lapNumber') if laps else '-')
    driver_stint_number = stint.get('driverStintNumber') or stint.get('stintNumber') or '-'
    car_stint_number = stint.get('stintNumber') or '-'
    c.drawRightString(
        PAGE_W - 28,
        PAGE_H - 43,
        f"Driver stint {driver_stint_number}  |  Car stint {car_stint_number}  |  laps {start_lap}-{end_lap}"
    )

    draw_chart(c, 28, 328, PAGE_W - 56, 190, 'Lap times', stint['laps'], 'lapTimeMs', stint['stats'].get('averageLapMs'), True, 'status')
    chart_w = (PAGE_W - 72) / 3
    draw_chart(c, 28, 184, chart_w, 132, 'Sector 1', stint['laps'], 'sector1Ms', stint['stats'].get('averageSector1Ms'), True, 'sector1Status')
    draw_chart(c, 36 + chart_w, 184, chart_w, 132, 'Sector 2', stint['laps'], 'sector2Ms', stint['stats'].get('averageSector2Ms'), True, 'sector2Status')
    draw_chart(c, 44 + chart_w * 2, 184, chart_w, 132, 'Sector 3', stint['laps'], 'sector3Ms', stint['stats'].get('averageSector3Ms'), True, 'sector3Status')

    bottom_w = (PAGE_W - 72) / 3
    draw_summary(c, 28, 34, bottom_w, 138, stint)
    draw_comparisons(c, 36 + bottom_w, 34, bottom_w, 138, stint)
    draw_insights(c, 44 + bottom_w * 2, 34, bottom_w, 138, stint)
    draw_legend(c, 35, 19)
    draw_consistency_note(c, 44 + bottom_w * 2 + 8, 23)
    c.setFillColor(MUTED)
    c.setFont('Helvetica', 6.5)
    c.drawRightString(PAGE_W - 28, 18, f'Generated from stored race data | page {page_number}')


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
