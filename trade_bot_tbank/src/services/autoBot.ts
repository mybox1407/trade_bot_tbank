import { getCandles, getCurrentPrice } from './exchange';
import { detectMarketState, computeCoherenceScore } from './marketState';
import {
  analyzeMarketMultiTimeframe,
  Candle,
  buildHtfBiasSeries,
  EntryMode,
  MarketRegime,
  BREAKOUT_TIME_FAIL_BARS,
  BREAKOUT_TIME_FAIL_MIN_MFE_R,
  BREAKOUT_MIN_TP1_R
} from './strategy';
import {
  getAllPositions,
  openPosition,
  closePosition,
  getAvailableBalance,
  getBalance,
  MAX_OPEN_POSITIONS,
  STARTING_BALANCE
} from './positionState';
import { logSignalCheck, logTrade } from './logger';
import axios from 'axios';

export const AUTO_BOT_CONFIG = {
  symbols: ['TATN', 'GAZP', 'NVTK', 'ROSN', 'SBER', 'MTSS', 'IRKT', 'AFLT', 'OZON', 'LKOH', 'VTBR'] as const,
  timeframe: '5m' as const,
  contextTimeframe: '15m' as const,
  entryTriggerTimeframe: '1m' as const,
  oneMinuteTriggerIntervalMs: 15 * 1000,

  candlesLimit: 300,
  contextCandlesLimit: 250,
  htfCandlesLimit: 300,
  regimeCheckIntervalMs: 5 * 60 * 1000,
  barCloseDelaySec: 15,
  dropFormingCandle: true,
  tradingHoursEnabled: true,

  tradingWindows: [
    [10 * 60 + 1, 18 * 60 + 54],
    [19 * 60 + 1, 23 * 60 + 45]
  ] as const,

  monitorTradingWindows: [
    [10 * 60, 18 * 60 + 54],
    [19 * 60 + 1, 23 * 60 + 49]
  ] as const,

  maxSleepMs: 6 * 60 * 60 * 1000,
  logWhenMarketClosed: false,
  positionMonitorIntervalMs: 15 * 1000,
  maxPositions: MAX_OPEN_POSITIONS,
  positionSizeFraction: 0.3,
  startingBalance: STARTING_BALANCE,
  allowedMarketStates: ['resonant', 'transition'] as const,
  htfFilterEnabled: true,
  htfMinAdx1h: 18,
  entryTimeoutBars: 4,
  logSignals: true,
  logTrades: true,
  telegramEnabled: true,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  telegramSignalChecksEnabled: true,
  telegramSessionNotificationsEnabled: true,
  telegramSummaryMode: true
} as const;

const WEEKEND_HOLIDAYS_2026 = [
  '2026-01-03', '2026-01-04', '2026-01-10', '2026-01-11',
  '2026-02-14', '2026-02-15',
  '2026-03-07', '2026-03-08', '2026-03-21', '2026-03-22',
  '2026-05-09', '2026-05-10',
  '2026-06-20', '2026-06-21',
  '2026-08-01', '2026-08-02', '2026-08-15', '2026-08-16',
  '2026-09-12', '2026-09-13',
  '2026-10-24', '2026-10-25',
  '2026-12-05', '2026-12-06'
];

type Symbol = typeof AUTO_BOT_CONFIG.symbols[number];
type TradingWindows = readonly (readonly [number, number])[];
type SessionState = 'open' | 'closed';

type CloseReason =
  | 'take_profit'
  | 'stop_loss'
  | 'breakout_time_fail'
  | 'session_close'
  | 'manual';

interface PendingSignal {
  symbol: Symbol;
  side: 'long' | 'short';
  entryMode: EntryMode;
  entryPrice: number;
  stopLossPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  quantity: number;
  positionSize: number;
  regime: MarketRegime;
  initialR: number;
  signalTime: number;
  barsWaited: number;
  lastAtr: number;
  timeFailBars: number;
  timeFailMinMfeR: number;
  minTp1R: number;
  signalCandleTime: number;
  breakoutLevel: number;
}

interface BreakoutRuntimeState {
  symbol: Symbol;
  side: 'long' | 'short';
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  initialR: number;
  regimeAtEntry: MarketRegime;
  openedAt: number;
  signalCandleTime: number;
  timeFailBars: number;
  timeFailMinMfeR: number;
  processedCandleTimes: Set<number>;
  maxFavorableExcursionR: number;
}

interface SignalResult {
  symbol: Symbol;
  regime: MarketRegime;
  hasSignal: boolean;

  side?: 'long' | 'short';
  entryMode?: EntryMode;

  rejectReason?: string;
  rejectReasons?: string[];

  adx?: number;
  atrPct?: number;

  error?: string;
}

const pendingSignals = new Map<Symbol, PendingSignal>();
const breakoutRuntimeState = new Map<Symbol, BreakoutRuntimeState>();

let isRegimeCheckRunning = false;
let isPositionMonitorRunning = false;
let lastSessionState: SessionState | null = null;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowMs() {
  return Date.now();
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toISOString();
}

function formatMoney(value: number) {
  return value.toFixed(2);
}

function formatAtr(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(2)
    : null;
}

function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>
) {
  const line =
    `[${formatTime(nowMs())}] ` +
    `[AUTO-BOT] ` +
    `[${level.toUpperCase()}] ` +
    message;

  if (meta) console.log(line, meta);
  else console.log(line);
}

function maskSecret(value: string): string {
  if (!value) return value;
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function maskedConfig() {
  return {
    ...AUTO_BOT_CONFIG,
    telegramBotToken: maskSecret(AUTO_BOT_CONFIG.telegramBotToken)
  };
}

const MSK_OFFSET_MIN = 180;

function timeframeToMs(timeframe: string): number {
  const match = /^(\d+)([mhd])$/.exec(timeframe);
  if (!match) throw new Error(`Unsupported timeframe: ${timeframe}`);
  const value = Number(match[1]);
  const unitMs = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000;
  return value * unitMs;
}

function msUntilNextBarClose(now: number, barMs: number, delayMs: number): number {
  const nextClose = (Math.floor(now / barMs) + 1) * barMs;
  return nextClose + delayMs - now;
}

function getMarketTimeParts(now: number): { weekday: number; minutes: number } {
  const shifted = new Date(now + MSK_OFFSET_MIN * 60_000);
  return {
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  };
}

function formatMskTime(now: number): string {
  const { minutes } = getMarketTimeParts(now);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')} МСК`;
}

function isWeekendHoliday(date: Date): boolean {
  const dateStr = date.toISOString().split('T')[0];
  return WEEKEND_HOLIDAYS_2026.includes(dateStr);
}

function isWithinTradingWindows(now: number, windows: TradingWindows): boolean {
  const { weekday, minutes } = getMarketTimeParts(now);
  const currentDate = new Date(now);
  if ((weekday === 0 || weekday === 6) && isWeekendHoliday(currentDate)) {
    return false;
  }

  return windows.some(([start, end]) => minutes >= start && minutes <= end);
}

function isTradingWindowOpen(now: number): boolean {
  return isWithinTradingWindows(now, AUTO_BOT_CONFIG.tradingWindows);
}

function isMonitorWindowOpen(now: number): boolean {
  return isWithinTradingWindows(now, AUTO_BOT_CONFIG.monitorTradingWindows);
}

function getSessionState(now: number): SessionState {
  return isMonitorWindowOpen(now) ? 'open' : 'closed';
}

function nextTradingWindowOpenMs(now: number): number | null {
  const mskNow = now + MSK_OFFSET_MIN * 60_000;
  const mskMidnight = Math.floor(mskNow / 86_400_000) * 86_400_000;
  for (let dayOffset = 0; dayOffset < 9; dayOffset++) {
    for (const [startMinutes] of AUTO_BOT_CONFIG.tradingWindows) {
      const openTimestamp = mskMidnight - MSK_OFFSET_MIN * 60_000 + startMinutes * 60_000 + dayOffset * 86_400_000;
      if (openTimestamp <= now) continue;
      const { weekday } = getMarketTimeParts(openTimestamp);
      if (weekday === 0 || weekday === 6) continue;
      return openTimestamp;
    }
  }

  return null;
}

function computeRegimeDelayMs(): number {
  const now = nowMs();
  const entryBarMs = timeframeToMs(AUTO_BOT_CONFIG.timeframe);
  const delayMs = AUTO_BOT_CONFIG.barCloseDelaySec * 1000;
  const barDelay = msUntilNextBarClose(now, entryBarMs, delayMs);
  if (!AUTO_BOT_CONFIG.tradingHoursEnabled) return barDelay;
  if (isTradingWindowOpen(now)) return barDelay;
  const nextOpen = nextTradingWindowOpenMs(now);
  if (nextOpen === null) return barDelay;
  const sleepMs = Math.min(nextOpen + delayMs - now, AUTO_BOT_CONFIG.maxSleepMs);
  return Math.max(sleepMs, 1_000);
}

function candleOpenTimeMs(candle: Candle): number | null {
  const record = candle as unknown as Record<string, unknown>;
  const time = record.time ?? record.datetime ?? record.timestamp;
  if (time === null || time === undefined) return null;
  if (typeof time === 'number') return time > 1e12 ? time : time * 1000;
  if (time instanceof Date) return time.getTime();
  const parsed = Date.parse(String(time));
  return Number.isNaN(parsed) ? null : parsed;
}

function trimCandles(candles: Candle[], limit: number, intervalMs: number): Candle[] {
  let output = candles;
  if (AUTO_BOT_CONFIG.dropFormingCandle && output.length > 0) {
    const lastOpen = candleOpenTimeMs(output[output.length - 1]);
    if (lastOpen !== null && lastOpen + intervalMs > nowMs()) {
      output = output.slice(0, -1);
    }
  }

  if (output.length > limit) output = output.slice(-limit);
  return output;
}

function getSignalCandleTime(indicators: Record<string, unknown> | undefined): number {
  const signalTimeUtc = indicators?.signalTimeUtc;
  if (typeof signalTimeUtc === 'string') {
    const parsed = Date.parse(signalTimeUtc);
    if (Number.isFinite(parsed)) return parsed;
  }

  return nowMs();
}

function getPositionKey(symbol: string): Symbol | null {
  return AUTO_BOT_CONFIG.symbols.includes(symbol as Symbol) ? symbol as Symbol : null;
}

function getExitReasonFromCandle(
  position: { side: 'long' | 'short'; stopLossPrice: number; takeProfitPrice: number },
  candle: Candle
): 'take_profit' | 'stop_loss' | null {
  if (position.side === 'long') {
    if (candle.low <= position.stopLossPrice) return 'stop_loss';
    if (candle.high >= position.takeProfitPrice) return 'take_profit';
    return null;
  }

  if (candle.high >= position.stopLossPrice) return 'stop_loss';
  if (candle.low <= position.takeProfitPrice) return 'take_profit';
  return null;
}

function getCurrentFavorableExcursionR(state: BreakoutRuntimeState, candle: Candle): number {
  if (!Number.isFinite(state.initialR) || state.initialR <= 0) return 0;
  if (state.side === 'long') {
    return Math.max(0, (candle.high - state.entryPrice) / state.initialR);
  }

  return Math.max(0, (state.entryPrice - candle.low) / state.initialR);
}

function getClosedBarsAfterEntry(candles: Candle[], state: BreakoutRuntimeState, now: number): Candle[] {
  const barMs = timeframeToMs(AUTO_BOT_CONFIG.timeframe);
  return candles
    .filter(candle => {
      const openTime = candleOpenTimeMs(candle);
      if (openTime === null) return false;
      const closeTime = openTime + barMs;
      return openTime > state.signalCandleTime && closeTime <= now;
    })
    .sort((a, b) => {
      const timeA = candleOpenTimeMs(a) ?? 0;
      const timeB = candleOpenTimeMs(b) ?? 0;
      return timeA - timeB;
    });
}

function getTimeFailState(
  state: BreakoutRuntimeState,
  candles: Candle[],
  now: number
): { barsElapsed: number; maxFavorableExcursionR: number; failed: boolean; newlyProcessedBars: number } {
  const closedBars = getClosedBarsAfterEntry(candles, state, now);
  let newlyProcessedBars = 0;
  for (const candle of closedBars) {
    const candleTime = candleOpenTimeMs(candle);
    if (candleTime === null || state.processedCandleTimes.has(candleTime)) continue;
    state.processedCandleTimes.add(candleTime);
    newlyProcessedBars += 1;
    const candleMfeR = getCurrentFavorableExcursionR(state, candle);
    state.maxFavorableExcursionR = Math.max(state.maxFavorableExcursionR, candleMfeR);
  }

  const barsElapsed = state.processedCandleTimes.size;
  return {
    barsElapsed,
    maxFavorableExcursionR: state.maxFavorableExcursionR,
    failed: barsElapsed >= state.timeFailBars && state.maxFavorableExcursionR < state.timeFailMinMfeR,
    newlyProcessedBars
  };
}

async function loadClosed5mCandles(symbol: Symbol): Promise<Candle[]> {
  const raw = await getCandles(symbol, AUTO_BOT_CONFIG.timeframe, AUTO_BOT_CONFIG.candlesLimit);
  return trimCandles(raw, AUTO_BOT_CONFIG.candlesLimit, timeframeToMs(AUTO_BOT_CONFIG.timeframe));
}

async function sendTelegramMessage(message: string) {
  if (!AUTO_BOT_CONFIG.telegramEnabled) return;
  if (!AUTO_BOT_CONFIG.telegramBotToken || !AUTO_BOT_CONFIG.telegramChatId) {
    log('warn', 'Telegram not configured: missing token or chatId');
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${AUTO_BOT_CONFIG.telegramBotToken}/sendMessage`;
    await axios.post(url, { chat_id: AUTO_BOT_CONFIG.telegramChatId, text: message });
  } catch (error) {
    log('error', 'Telegram send failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

async function notifySessionStateIfChanged(now: number) {
  const currentState = getSessionState(now);
  if (lastSessionState === currentState) return;
  lastSessionState = currentState;
  if (!AUTO_BOT_CONFIG.telegramSessionNotificationsEnabled) return;
  const message = currentState === 'open'
    ? ['[СЕССИЯ]', 'Торговая сессия открыта', `Время: ${formatMskTime(now)}`].join('\n')
    : ['[СЕССИЯ]', 'Торговая сессия закрыта', `Время: ${formatMskTime(now)}`].join('\n');
  await sendTelegramMessage(message);
  log('info', `Trading session state changed: ${currentState}`);
}

function getEntryModeLabel(entryMode: EntryMode | unknown): string {
  if (entryMode === 'breakout_entry') return 'ПРОБОЙ';
  if (entryMode === 'standard') return 'СТАНДАРТНЫЙ';
  return 'НЕ ОПРЕДЕЛЁН';
}

function formatRejectReason(code: string): string {
  const map: Record<string, string> = {
    '15m_context_not_tradeable': '15m-контекст не подходит',
    '5m_body_too_small': '5m-свеча слишком слабая',
    '5m_body_too_large': '5m-свеча слишком большая',
    '5m_volume_below_threshold': 'недостаточный объём',
    '5m_short_overextended_from_ema20': 'short запоздал: цена далеко ниже EMA20',
    '5m_long_overextended_from_ema20': 'long запоздал: цена далеко выше EMA20',
    '5m_short_close_not_near_low': 'short: закрытие далеко от low',
    '5m_long_close_not_near_high': 'long: закрытие далеко от high',
    'breakout_long_too_far_from_level': 'long-пробой уже слишком далеко от уровня',
    'breakout_short_too_far_from_level': 'short-пробой уже слишком далеко от уровня',
    'htf_gate': 'направление против 1h',
    'htf_warmup': 'недостаточно 1h-данных',
    'stop_distance': 'стоп вне допустимой дистанции',
    'size_calculation': 'не рассчитан размер позиции',
    'not_trading_hour': 'вне торгового времени',
    'no_5m_entry_conditions': 'условия 5m-входа не выполнены',
    'conditions_not_met': 'условия входа не выполнены',
    '15m_breakout_context_not_tradeable': '15m-контекст для пробоя не подходит',
    '5m_breakout_not_confirmed_or_too_late': 'пробой не подтверждён или вход запоздал',
    'breakout_long_close_not_near_high': 'long-пробой: закрытие недостаточно близко к high',
    'breakout_short_close_not_near_low': 'short-пробой: закрытие недостаточно близко к low',
    'breakout_tp1_r_too_low': 'TP1/R меньше минимально допустимого',
    'no_breakout_entry_conditions': 'условия пробойного входа не выполнены',
    'breakout_long_not_deep_enough': 'long-пробой недостаточно глубоко за уровнем',
    'breakout_short_not_deep_enough': 'short-пробой недостаточно глубоко за уровнем'
  };
  return map[code] ?? code;
}

function formatShortRejectReason(
  reason?: string,
  rejectReasons?: string[]
): string {
  const codes = rejectReasons?.length
    ? rejectReasons
    : reason
      ? [reason]
      : [];

  if (!codes.length) {
    return 'Conditions not met';
  }

  const map: Record<string, string> = {
    '15m_breakout_context_not_tradeable': 'Context not tradeable',
    '5m_body_too_small': 'Body too small',
    '5m_body_too_large': 'Body too large',
    '5m_volume_below_threshold': 'Low volume',
    '5m_breakout_not_confirmed_or_too_late': 'No breakout confirmation',
    'breakout_tp1_r_too_low': 'TP1/R too low',
    'stop_distance': 'Stop distance invalid',
    'size_calculation': 'Size calculation failed',
    'htf_gate': 'Against 1h trend',
    'htf_warmup': '1h warm-up',
    'not_trading_hour': 'Outside trading hours',
    'signal_expired': 'Signal expired',
    'counter_trend_blocked': 'Counter-trend blocked',
    'incomplete_signal_data': 'Incomplete signal data',
    'market_state_not_ready': 'Market state not ready',
    'not_enough_1m_data': 'Not enough 1m data',
    'not_enough_5m_data': 'Not enough 5m data',
    'not_enough_15m_data': 'Not enough 15m data',
    'position_already_open': 'Position already open'
  };

  return codes
    .slice(0, 2)
    .map(code => map[code] ?? code)
    .join(', ');
}

function getReservedNotionalSafe(): number {
  return getAllPositions().reduce(
    (sum, position) => sum + position.notional,
    0
  );
}

function formatSignalSummary(
  signalResults: SignalResult[]
): string {
  const positions = getAllPositions();
  const equity = getBalance();
  const reserved = getReservedNotionalSafe();
  const available = getAvailableBalance();

  const signals = signalResults.filter(
    result => result.hasSignal
  ).length;

  const errors = signalResults.filter(
    result => Boolean(result.error)
  ).length;

  const noSignals = signalResults.filter(
    result => !result.hasSignal && !result.error
  ).length;

  const lines: string[] = [
    '📊 Signal Check Summary',
    '',
    `📌 Open positions: ${positions.length}/${AUTO_BOT_CONFIG.maxPositions}`
  ];

  if (positions.length === 0) {
    lines.push('No open positions');
  } else {
    for (const position of positions) {
      lines.push(
        `• ${position.symbol} ` +
        `${position.side.toUpperCase()} @ ` +
        `${formatMoney(position.entryPrice)}`
      );
    }
  }

  lines.push(
    '',
    `💼 Equity: ${formatMoney(equity)} руб`,
    `🔒 Reserved: ${formatMoney(reserved)} руб`,
    `💵 Available: ${formatMoney(available)} руб`,
    '',
    '🔎 Signal scan'
  );

  for (const result of signalResults) {
    const icon = result.hasSignal ? '🎯' : '⏳';

    if (result.hasSignal) {
      lines.push(
        `${icon} ${result.symbol}: ${result.regime} | ` +
        `${result.side?.toUpperCase() ?? 'SIGNAL'} | ` +
        `${result.entryMode ?? 'breakout_entry'}`
      );

      continue;
    }

    let explanation: string;

    if (result.regime === 'unknown') {
      explanation = 'Unknown regime';
    } else if (
      result.regime === 'high_volatility' &&
      result.atrPct !== undefined
    ) {
      explanation =
        `High volatility (ATR%: ` +
        `${result.atrPct.toFixed(4)})`;
    } else if (
      result.regime === 'range' &&
      result.adx !== undefined
    ) {
      explanation =
        `Range (ADX: ${result.adx.toFixed(2)})`;
    } else {
      explanation = formatShortRejectReason(
        result.rejectReason,
        result.rejectReasons
      );
    }

    lines.push(
      `${icon} ${result.symbol}: ${result.regime} | ` +
      `No signal | ${explanation}`
    );
  }

  lines.push(
    '',
    `Signals: ${signals} | ` +
    `No signals: ${noSignals} | ` +
    `Open: ${positions.length}/${AUTO_BOT_CONFIG.maxPositions} | ` +
    `Errors: ${errors}`,
    formatTime(nowMs())
  );

  return lines.join('\n');
}

async function sendTelegramSignalSummary(
  signalResults: SignalResult[]
) {
  if (!AUTO_BOT_CONFIG.telegramEnabled) {
    return;
  }

  await sendTelegramMessage(
    formatSignalSummary(signalResults)
  );
}

export async function sendTelegramTestMessage() {
  const message = [
    '[TEST] Автономный торговый бот MOEX',
    '',
    'Статус: OK',
    `Время: ${formatTime(nowMs())}`,
    `Баланс: ${formatMoney(getBalance())} руб`,
    `Свободно: ${formatMoney(getAvailableBalance())} руб`,
    `Открыто позиций: ${getAllPositions().length}`,
    '',
    'Тикеры: TATN, GAZP, NVTK',
    'Контекст: 15m',
    'Вход: 5m после закрытия бара',
    'HTF: 1h',
    `Мониторинг позиции: ${AUTO_BOT_CONFIG.positionMonitorIntervalMs / 1000} сек`,
    `Уведомления о сессии: ${AUTO_BOT_CONFIG.telegramSessionNotificationsEnabled ? 'включены' : 'выключены'}`,
    'Telegram подключён и работает.'
  ].join('\n');
  await sendTelegramMessage(message);
  log('info', 'Telegram test message sent');
}

function formatOpenPositionMessage(
  symbol: string,
  side: 'long' | 'short',
  entryMode: EntryMode,
  signalPrice: number,
  entryPrice: number,
  quantity: number,
  positionSize: number,
  stopLoss: number,
  takeProfit: number,
  balanceBefore: number,
  balanceAfter: number,
  regime: string,
  plannedInitialR: number,
  minTp1R: number = BREAKOUT_MIN_TP1_R
) {
  const sideText = side === 'long' ? 'LONG' : 'SHORT';
  const actualInitialR = Math.abs(entryPrice - stopLoss);
  const actualTp1Distance = side === 'long' ? takeProfit - entryPrice : entryPrice - takeProfit;
  const actualTp1R = actualInitialR > 0 ? actualTp1Distance / actualInitialR : 0;
  return [
    `[ОТКРЫТИЕ ПОЗИЦИИ] ${sideText}`,
    '',
    `Тикер: ${symbol}`,
    `Цена сигнала: ${formatMoney(signalPrice)} руб`,
    `Цена исполнения: ${formatMoney(entryPrice)} руб`,
    `Drift: ${formatMoney(entryPrice - signalPrice)} руб`,
    `Количество: ${quantity} шт`,
    `Объём позиции: ${formatMoney(positionSize)} руб`,
    `Stop Loss: ${formatMoney(stopLoss)} руб`,
    `Take Profit: ${formatMoney(takeProfit)} руб`,
    `Плановый R: ${formatMoney(plannedInitialR)} руб`,
    `Фактический R: ${formatMoney(actualInitialR)} руб`,
    `Фактический TP1/R: ${actualTp1R.toFixed(2)}R`,
    `Минимальный TP1/R: ${minTp1R.toFixed(2)}R`,
    '',
    `Баланс до: ${formatMoney(balanceBefore)} руб`,
    `Баланс после: ${formatMoney(balanceAfter)} руб`,
    `Свободно: ${formatMoney(getAvailableBalance())} руб`,
    '',
    `Режим 15m: ${regime}`,
    `Путь входа: ${getEntryModeLabel(entryMode)}`,
    'Точка входа: 5m',
    `Время: ${formatTime(nowMs())}`
  ].join('\n');
}

function formatClosePositionMessage(
  symbol: string,
  side: 'long' | 'short',
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  realizedPnL: number,
  reason: CloseReason,
  balanceBefore: number,
  balanceAfter: number,
  totalCommission: number
) {
  const sideText = side === 'long' ? 'LONG' : 'SHORT';
  const pnlSign = realizedPnL >= 0 ? '+' : '';
  const reasonText =
    reason === 'take_profit' ? 'TAKE PROFIT' :
    reason === 'stop_loss' ? 'STOP LOSS' :
    reason === 'breakout_time_fail' ? 'BREAKOUT TIME FAIL' :
    reason === 'session_close' ? 'SESSION CLOSE' : 'MANUAL';
  const pnlPercent = balanceBefore > 0 ? ((realizedPnL / balanceBefore) * 100).toFixed(2) : '0.00';
  return [
    `[ЗАКРЫТИЕ ПОЗИЦИИ] ${sideText}`,
    '',
    `Тикер: ${symbol}`,
    `Цена входа: ${formatMoney(entryPrice)} руб`,
    `Цена выхода: ${formatMoney(exitPrice)} руб`,
    `Количество: ${quantity} шт`,
    `PNL: ${pnlSign}${formatMoney(realizedPnL)} руб (${pnlSign}${pnlPercent}%)`,
    `Комиссии: ${formatMoney(totalCommission)} руб`,
    '',
    `Баланс до: ${formatMoney(balanceBefore)} руб`,
    `Баланс после: ${formatMoney(balanceAfter)} руб`,
    `Изменение: ${pnlSign}${formatMoney(realizedPnL)} руб`,
    '',
    `Причина: ${reasonText}`,
    `Время: ${formatTime(nowMs())}`
  ].join('\n');
}

function getVolumeLogMeta(indicators: Record<string, unknown> | undefined) {
  if (!indicators) return {};
  return {
    volumeSpike: indicators.volumeSpike,
    volumeCurrent: indicators.volumeCurrent,
    volumeMedian: indicators.volumeMedian,
    volumeRatio: indicators.volumeRatio,
    volumeThreshold: indicators.volumeThreshold,
    volumeSampleSize: indicators.volumeSampleSize
  };
}

function get5mEntryLogMeta(indicators: Record<string, unknown> | undefined) {
  if (!indicators) return {};
  return {
    entryMode: indicators.entryMode,
    standardLongSignal: indicators.standardLongSignal,
    standardShortSignal: indicators.standardShortSignal,
    breakoutLongSignal: indicators.breakoutLongSignal,
    breakoutShortSignal: indicators.breakoutShortSignal,
    entryTimeframe: indicators.entryTimeframe,
    contextTimeframe: indicators.contextTimeframe,
    contextRegime: indicators.contextRegime,
    context15mAdx: indicators.context15mAdx,
    context15mBbWidth: indicators.context15mBbWidth,
    lastAtr: indicators.lastAtr5m ?? indicators.lastAtr,
    lastRsi: indicators.lastRsi5m ?? indicators.lastRsi,
    ema20_5m: indicators.ema20_5m,
    candleBody: indicators.candleBody5m ?? indicators.candleBody,
    candleBodyAtrRatio: indicators.candleBodyAtrRatio5m ?? indicators.candleBodyAtrRatio,
    minBody: indicators.minBody5m ?? indicators.minBody,
    maxBody: indicators.maxBody5m ?? indicators.maxBody,
    bodyValid: indicators.bodyValid ?? indicators.breakoutBodyWithinRange,
    breakoutBodyWithinRange: indicators.breakoutBodyWithinRange,
    localLow5m: indicators.localLow5m,
    localHigh5m: indicators.localHigh5m,
    shortBreakdownThreshold: indicators.shortBreakdownThreshold,
    longBreakoutThreshold: indicators.longBreakoutThreshold,
    confirmedBreakdown5m: indicators.confirmedBreakdown5m,
    confirmedBreakout5m: indicators.confirmedBreakout5m,
    breakoutEntryMaxDistanceAtr: indicators.breakoutEntryMaxDistanceAtr,
    freshLongBreakout: indicators.freshLongBreakout,
    freshShortBreakdown: indicators.freshShortBreakdown,
    longBreakoutDistanceAtr: indicators.longBreakoutDistanceAtr,
    shortBreakoutDistanceAtr: indicators.shortBreakoutDistanceAtr,
    shortExtensionFromEma20: indicators.shortExtensionFromEma20,
    longExtensionFromEma20: indicators.longExtensionFromEma20,
    maxEma20ExtensionAtr: indicators.maxEma20ExtensionAtr,
    shortNotOverextended: indicators.shortNotOverextended,
    longNotOverextended: indicators.longNotOverextended,
    closeNearLow: indicators.closeNearLow,
    closeNearHigh: indicators.closeNearHigh,
    htfEnabled: indicators.htfEnabled,
    htfBias: indicators.htfBias,
    htfAdx: indicators.htfAdx
  };
}

export async function runRegimeCheckCycle() {
  if (isRegimeCheckRunning) {
    log('warn', 'Regime check already running, skipping');
    return;
  }

  isRegimeCheckRunning = true;
  try {
    await notifySessionStateIfChanged(nowMs());
    if (AUTO_BOT_CONFIG.tradingHoursEnabled && !isTradingWindowOpen(nowMs())) {
      if (AUTO_BOT_CONFIG.logWhenMarketClosed) {
        log('info', 'Outside trading window, cycle skipped (no API calls)');
      }

      return;
    }

    log('info', '=== 5M ENTRY / 15M CONTEXT CYCLE START ===');
    const openPositions = getAllPositions();
    const openSymbols = new Set(openPositions.map(position => position.symbol));
    const signalResults: SignalResult[] = [];
    for (const symbol of AUTO_BOT_CONFIG.symbols) {
      if (openSymbols.has(symbol)) {
        log('info', `Skipping ${symbol}: position already open`);
        signalResults.push({
          symbol,
          regime: 'unknown',
          hasSignal: false,
          rejectReason: 'position_already_open'
        });
        continue;
      }

      if (pendingSignals.has(symbol)) {
        const pending = pendingSignals.get(symbol)!;
        if (pending.entryMode === 'breakout_entry') {
          log('info', `Breakout signal expired for ${symbol}: not filled immediately`, {
            entryMode: pending.entryMode,
            side: pending.side,
            signalPrice: pending.entryPrice,
            regime: pending.regime,
            barsWaited: pending.barsWaited
          });
          signalResults.push({
            symbol,
            regime: pending.regime,
            hasSignal: false,
            rejectReason: 'signal_expired'
          });
          pendingSignals.delete(symbol);
          continue;
        }

        log('warn', `Unsupported pending signal removed for ${symbol}`, {
          entryMode: pending.entryMode,
          side: pending.side
        });
        pendingSignals.delete(symbol);
        continue;
      }

      try {
        const availableBalanceNow = getAvailableBalance();
        const result = await processSymbol(symbol, availableBalanceNow);
        signalResults.push(result);
      } catch (error) {
        log('error', `Error processing ${symbol}`, {
          error: error instanceof Error ? error.message : String(error)
        });
        signalResults.push({
          symbol,
          regime: 'unknown',
          hasSignal: false,
          error: error instanceof Error ? error.message : String(error)
        });
        await sleep(500);
      }
    }

    if (AUTO_BOT_CONFIG.telegramSummaryMode) {
      await sendTelegramSignalSummary(signalResults);
    }

    log('info', '=== 5M ENTRY / 15M CONTEXT CYCLE END ===');
  } finally {
    isRegimeCheckRunning = false;
  }
}

function floorToBar(timestamp: number, barMs: number): number {
  return Math.floor(timestamp / barMs) * barMs;
}

async function processSymbol(symbol: Symbol, availableBalance: number): Promise<SignalResult> {
  log('info', `Processing ${symbol}...`);
  const candles1mRaw = await getCandles(symbol, '1m', 200);
  const candles1m = trimCandles(candles1mRaw, 1000, timeframeToMs('1m'));
  if (candles1m.length < 100) {
    log('warn', `${symbol}: not enough 1m entry-trigger candles`, { received: candles1m.length, required: 100 });
    return { symbol, regime: 'unknown', hasSignal: false, rejectReason: 'not_enough_1m_data' };
  }

  const candles15mRaw = await getCandles(symbol, AUTO_BOT_CONFIG.contextTimeframe, AUTO_BOT_CONFIG.contextCandlesLimit);
  const candles15m = trimCandles(candles15mRaw, AUTO_BOT_CONFIG.contextCandlesLimit, timeframeToMs(AUTO_BOT_CONFIG.contextTimeframe));
  if (candles15m.length < 220) {
    log('warn', `${symbol}: not enough 15m context candles`, { received: candles15m.length, required: 220 });
    return { symbol, regime: 'unknown', hasSignal: false, rejectReason: 'not_enough_15m_data' };
  }

  const candles5mRaw = await getCandles(symbol, AUTO_BOT_CONFIG.timeframe, AUTO_BOT_CONFIG.candlesLimit);
  const candles5m = trimCandles(candles5mRaw, AUTO_BOT_CONFIG.candlesLimit, timeframeToMs(AUTO_BOT_CONFIG.timeframe));
  if (candles5m.length < 60) {
    log('warn', `${symbol}: not enough 5m entry candles`, { received: candles5m.length, required: 60 });
    return { symbol, regime: 'unknown', hasSignal: false, rejectReason: 'not_enough_5m_data' };
  }

  const candles1hRaw = await getCandles(symbol, '1h', AUTO_BOT_CONFIG.htfCandlesLimit);
  const candles1h = trimCandles(candles1hRaw, AUTO_BOT_CONFIG.htfCandlesLimit, timeframeToMs('1h'));
  if (candles1h.length < 100) {
    log('warn', `${symbol}: not enough 1h candles for HTF`, { received: candles1h.length, required: 100 });
  }

  const htfSeries = buildHtfBiasSeries(candles1h, AUTO_BOT_CONFIG.htfMinAdx1h);
  const marketState = detectMarketState(candles15m);
  if (!marketState.ready) {
    log('warn', `${symbol}: 15m market state not ready`);
    return { symbol, regime: 'unknown', hasSignal: false, rejectReason: 'market_state_not_ready' };
  }

  log('info', `${symbol} market state`, {
    state: marketState.state,
    sideBias: marketState.sideBias,
    coherence: marketState.coherence.toFixed(4),
    trendScore: marketState.trendScore.toFixed(4),
    noiseScore: marketState.noiseScore.toFixed(4),
    contextTimeframe: AUTO_BOT_CONFIG.contextTimeframe,
    entryTimeframe: AUTO_BOT_CONFIG.timeframe
  });
  const signal = analyzeMarketMultiTimeframe({
    candles15m,
    candles5m,
    candles1m,
    balance: availableBalance,
    htf: {
      enabled: AUTO_BOT_CONFIG.htfFilterEnabled,
      minAdx1h: AUTO_BOT_CONFIG.htfMinAdx1h,
      precomputedHtf: htfSeries
    }
  });
  if (!signal.buy && !signal.sell) {
    const indicators = signal.indicators ?? {};
    log('info', `${symbol}: no 5m entry signal`, {
      regime: signal.regime,
      entryMode: signal.entryMode,
      reject: indicators.reject ?? 'conditions_not_met',
      entryTimeframe: indicators.entryTimeframe ?? '5m',
      contextTimeframe: indicators.contextTimeframe ?? '15m',
      marketState: marketState.state,
      marketBias: marketState.sideBias,
      price: signal.price,
      stopPct: indicators.stopPct,
      sideWouldBe: indicators.sideWouldBe,
      entryModeWouldBe: indicators.entryModeWouldBe,
      htfSeriesLength: htfSeries.length,
      htfEnabled: indicators.htfEnabled,
      htfBias: indicators.htfBias,
      ...get5mEntryLogMeta(indicators),
      ...getVolumeLogMeta(indicators),
      breakoutLongTriggered: indicators.breakoutLongTriggered,
      breakoutShortTriggered: indicators.breakoutShortTriggered,
      has1mTrigger: indicators.has1mTrigger,
      breakoutEntryMinDistanceAtr: indicators.breakoutEntryMinDistanceAtr,
      breakoutEntryMaxDistanceAtr: indicators.breakoutEntryMaxDistanceAtr,
      tp1ToInitialR: indicators.tp1ToInitialR,
      minBreakoutTp1R: indicators.minBreakoutTp1R,
      rejectReasons: indicators.rejectReasons
    });
    return {
      symbol,
      regime: signal.regime,
      hasSignal: false,

      rejectReason:
        typeof indicators.reject === 'string'
          ? indicators.reject
          : 'conditions_not_met',

      rejectReasons:
        Array.isArray(indicators.rejectReasons)
          ? indicators.rejectReasons.filter(
              (value): value is string =>
                typeof value === 'string'
            )
          : undefined,

      adx:
        typeof indicators.context15mAdx === 'number'
          ? indicators.context15mAdx
          : undefined,

      atrPct:
        typeof indicators.atrPct === 'number'
          ? indicators.atrPct
          : undefined
    };
  }

  const side = signal.side;
  if (side === 'none') {
    log('warn', `${symbol}: signal side=none but buy/sell set?`);
    return { symbol, regime: signal.regime, hasSignal: false, rejectReason: 'side_none' };
  }

  const signalEntryMode: EntryMode = signal.entryMode ?? (signal.indicators?.entryMode as EntryMode | undefined) ?? 'none';
  if (signalEntryMode !== 'breakout_entry') {
    log('warn', `${symbol}: non-breakout signal rejected`, { entryMode: signalEntryMode, side, regime: signal.regime });
    return { symbol, regime: signal.regime, hasSignal: false, rejectReason: 'not_breakout_entry' };
  }

  const bias = marketState.sideBias;
  const isCounterTrend = (bias === 'long' && side === 'short') || (bias === 'short' && side === 'long');
  if (isCounterTrend) {
    log('info', `${symbol}: breakout signal blocked by direction filter`, {
      entryMode: signalEntryMode,
      regime: signal.regime,
      marketBias: bias,
      signalSide: side,
      price: signal.price
    });
    return { symbol, regime: signal.regime, hasSignal: false, rejectReason: 'counter_trend_blocked' };
  }

  const coherence = computeCoherenceScore(candles15m, side);
  log('info', `${symbol}: breakout coherence diagnostic`, { entryMode: signalEntryMode, regime: signal.regime, side, coherence });
  if (!signal.stopLossPrice || !signal.takeProfit1Price || !signal.takeProfit2Price || !signal.quantity) {
    log('warn', `${symbol}: incomplete 5m signal data`, { ...signal, entryMode: signalEntryMode });
    return { symbol, regime: signal.regime, hasSignal: false, rejectReason: 'incomplete_signal_data' };
  }

  const rawSignalTimeUtc = signal.indicators?.signalTimeUtc;
  const signalCandleTime = floorToBar(getSignalCandleTime(signal.indicators), timeframeToMs(AUTO_BOT_CONFIG.timeframe));
  log('info', `BREAKOUT SIGNAL TIME: ${symbol}`, {
    rawSignalTimeUtc,
    normalizedSignalCandleTime: formatTime(signalCandleTime),
    generatedAt: formatTime(nowMs()),
    signalCandleIndex: signal.indicators?.signal5mIndex
  });
  const breakoutLevel = side === 'long'
    ? Number(signal.indicators?.longBreakoutThreshold)
    : Number(signal.indicators?.shortBreakdownThreshold);
  const pending: PendingSignal = {
    symbol,
    side,
    entryMode: 'breakout_entry',
    entryPrice: signal.price,
    stopLossPrice: signal.stopLossPrice,
    takeProfit1Price: signal.takeProfit1Price,
    takeProfit2Price: signal.takeProfit2Price,
    quantity: signal.quantity,
    positionSize: signal.positionSize ?? signal.quantity * signal.price,
    regime: signal.regime,
    initialR: signal.initialR ?? 0,
    signalTime: nowMs(),
    barsWaited: 0,
    lastAtr: typeof signal.indicators?.lastAtr === 'number' && Number.isFinite(signal.indicators.lastAtr) ? signal.indicators.lastAtr : 0,
    timeFailBars: signal.timeFailBars > 0 ? signal.timeFailBars : BREAKOUT_TIME_FAIL_BARS,
    timeFailMinMfeR: signal.timeFailMinMfeR ?? BREAKOUT_TIME_FAIL_MIN_MFE_R,
    minTp1R: signal.minTp1R ?? BREAKOUT_MIN_TP1_R,
    signalCandleTime,
    breakoutLevel
  };
  pendingSignals.set(symbol, pending);
  if (AUTO_BOT_CONFIG.logSignals) {
    logSignalCheck({
      timestamp: formatTime(nowMs()),
      symbol,
      side,
      entryMode: signalEntryMode,
      regime: signal.regime,
      regimeAtEntry: signal.regime,
      marketState: marketState.state,
      sideBias: marketState.sideBias,
      coherence: coherence.toFixed(6),
      entryTimeframe: '5m',
      contextTimeframe: '15m',
      signalTimeUtc: rawSignalTimeUtc,
      signalCandleTime: formatTime(signalCandleTime),
      entryPrice: signal.price,
      stopLoss: signal.stopLossPrice,
      tp1: signal.takeProfit1Price,
      tp2: signal.takeProfit2Price,
      quantity: signal.quantity,
      positionSize: pending.positionSize,
      initialR: (signal.initialR ?? 0).toFixed(4),
      timeFailBars: pending.timeFailBars,
      timeFailMinMfeR: pending.timeFailMinMfeR,
      minTp1R: pending.minTp1R,
      action: 'signal_generated'
    });
  }

  log('info', `SIGNAL GENERATED: ${symbol} ${side.toUpperCase()} (5m entry / 15m context)`, {
    entryMode: signalEntryMode,
    entry: signal.price,
    sl: signal.stopLossPrice,
    tp1: signal.takeProfit1Price,
    tp2: signal.takeProfit2Price,
    qty: signal.quantity,
    size: pending.positionSize,
    R: signal.initialR?.toFixed(4),
    marketState: marketState.state,
    marketBias: marketState.sideBias,
    coherence: coherence.toFixed(4),
    signalTimeUtc: rawSignalTimeUtc,
    signalCandleTime: formatTime(signalCandleTime),
    timeFailBars: pending.timeFailBars,
    timeFailMinMfeR: pending.timeFailMinMfeR,
    minTp1R: pending.minTp1R,
    ...get5mEntryLogMeta(signal.indicators),
    ...getVolumeLogMeta(signal.indicators),
    breakoutLongTriggered: signal.indicators?.breakoutLongTriggered,
    breakoutShortTriggered: signal.indicators?.breakoutShortTriggered,
    has1mTrigger: signal.indicators?.has1mTrigger
  });
  return {
    symbol,
    regime: signal.regime,
    hasSignal: true,
    side,
    entryMode: signalEntryMode,
    adx: signal.indicators?.context15mAdx as number | undefined
  };
}

async function tryExecutePendingSignal(symbol: Symbol) {
  const pending = pendingSignals.get(symbol);
  if (!pending) return;
  try {
    const quoteStartedAt = nowMs();
    const currentPrice = await getCurrentPrice(symbol);
    const quoteReceivedAt = nowMs();
    const balanceBefore = getBalance();
    const baseTolerance = 0.001;
    const lastAtr = pending.lastAtr > 0 && Number.isFinite(pending.lastAtr) ? pending.lastAtr : 0;
    const atrTolerance = lastAtr > 0 && pending.entryPrice > 0 ? lastAtr / pending.entryPrice : 0;
    const standardSlippageTolerance = baseTolerance + 0.5 * atrTolerance;
    const breakoutSlippageTolerance = Math.max(standardSlippageTolerance, 1.25 * atrTolerance);
    const slippageTolerance = pending.entryMode === 'breakout_entry' ? breakoutSlippageTolerance : standardSlippageTolerance;
    const priceDiff = Math.abs(currentPrice - pending.entryPrice) / pending.entryPrice;
    const fillDrift = currentPrice - pending.entryPrice;
    const fillDriftPct = priceDiff * 100;
    const entryQuality = pending.side === 'short'
      ? currentPrice >= pending.entryPrice ? 'favorable_or_equal' : 'adverse'
      : currentPrice <= pending.entryPrice ? 'favorable_or_equal' : 'adverse';
    log('info', `${symbol}: execution quote`, {
      side: pending.side,
      entryMode: pending.entryMode,
      signalPrice: pending.entryPrice,
      currentPrice,
      fillDrift,
      fillDriftPct,
      entryQuality,
      quoteLatencyMs: quoteReceivedAt - quoteStartedAt,
      lastAtr,
      baseTolerance,
      atrTolerance,
      standardSlippageTolerance,
      breakoutSlippageTolerance,
      slippageTolerance,
      priceDiff
    });
    if (priceDiff > slippageTolerance) {
      const isBreakout = pending.entryMode === 'breakout_entry';
      log('info', isBreakout
        ? `${symbol}: breakout price moved too far (${fillDriftPct.toFixed(2)}%), cancelling`
        : `${symbol}: price moved too far (${fillDriftPct.toFixed(2)}%), waiting`, {
        side: pending.side,
        entryMode: pending.entryMode,
        signalPrice: pending.entryPrice,
        currentPrice,
        fillDrift,
        entryQuality,
        lastAtr,
        baseTolerance,
        atrTolerance,
        standardSlippageTolerance,
        breakoutSlippageTolerance,
        slippageTolerance,
        priceDiff,
        barsWaited: pending.barsWaited,
        timeoutBars: AUTO_BOT_CONFIG.entryTimeoutBars
      });
      if (isBreakout) pendingSignals.delete(symbol);
      return;
    }

    const stillBeyondBreakout =
      pending.side === 'long'
        ? currentPrice > pending.breakoutLevel
        : currentPrice < pending.breakoutLevel;

    if (!stillBeyondBreakout) {
      log('info', `${symbol}: breakout invalidated before execution`, {
        side: pending.side,
        currentPrice,
        breakoutLevel: pending.breakoutLevel
      });
      pendingSignals.delete(symbol);
      return;
    }

    const actualInitialR = Math.abs(currentPrice - pending.stopLossPrice);
    const actualTp1Distance = pending.side === 'long'
      ? pending.takeProfit1Price - currentPrice
      : currentPrice - pending.takeProfit1Price;
    const actualTp1R = actualInitialR > 0 ? actualTp1Distance / actualInitialR : 0;
    const minTp1R = pending.minTp1R ?? BREAKOUT_MIN_TP1_R;
    log('info', `${symbol}: actual breakout R/R check`, {
      side: pending.side,
      signalPrice: pending.entryPrice,
      executionPrice: currentPrice,
      fillDrift,
      stopLoss: pending.stopLossPrice,
      takeProfit1: pending.takeProfit1Price,
      plannedInitialR: pending.initialR,
      actualInitialR,
      actualTp1Distance,
      actualTp1R,
      minTp1R
    });
    if (!Number.isFinite(actualTp1R) || actualTp1R < minTp1R) {
      log('warn', `${symbol}: breakout cancelled by actual TP1/R`, {
        side: pending.side,
        signalPrice: pending.entryPrice,
        executionPrice: currentPrice,
        fillDrift,
        fillDriftPct,
        stopLoss: pending.stopLossPrice,
        takeProfit1: pending.takeProfit1Price,
        plannedInitialR: pending.initialR,
        actualInitialR,
        actualTp1Distance,
        actualTp1R,
        minTp1R,
        regime: pending.regime
      });
      pendingSignals.delete(symbol);
      return;
    }

    const result = openPosition({
      symbol: pending.symbol,
      side: pending.side,
      entryPrice: currentPrice,
      takeProfitPrice: pending.takeProfit1Price,
      stopLossPrice: pending.stopLossPrice,
      quantity: pending.quantity,
      entryMode: pending.entryMode,
      regimeAtEntry: pending.regime,
      initialR: actualInitialR,
      timeFailBars: pending.timeFailBars,
      timeFailMinMfeR: pending.timeFailMinMfeR,
      minTp1R: pending.minTp1R,
      signalCandleTime: pending.signalCandleTime
    });
    if (!result.ok) {
      log('warn', `Failed to open position for ${symbol}`, { entryMode: pending.entryMode, message: result.message });
      return;
    }

    pendingSignals.delete(symbol);
    const openedAt = nowMs();
    const signalCandleTime = floorToBar(pending.signalCandleTime, timeframeToMs(AUTO_BOT_CONFIG.timeframe));
    breakoutRuntimeState.set(symbol, {
      symbol,
      side: pending.side,
      entryPrice: currentPrice,
      stopLossPrice: pending.stopLossPrice,
      takeProfitPrice: pending.takeProfit1Price,
      initialR: actualInitialR,
      regimeAtEntry: pending.regime,
      openedAt,
      signalCandleTime,
      timeFailBars: pending.timeFailBars,
      timeFailMinMfeR: pending.timeFailMinMfeR,
      processedCandleTimes: new Set(),
      maxFavorableExcursionR: 0
    });
    const balanceAfter = getBalance();
    if (AUTO_BOT_CONFIG.logTrades) {
      logTrade({
        timestamp: formatTime(nowMs()),
        symbol: pending.symbol,
        side: pending.side,
        entryMode: pending.entryMode,
        action: 'open',
        entryPrice: currentPrice,
        stopLoss: pending.stopLossPrice,
        takeProfit: pending.takeProfit1Price,
        quantity: pending.quantity,
        positionSize: pending.positionSize,
        regime: pending.regime,
        initialR: actualInitialR.toFixed(4),
        balanceBefore,
        balanceAfter,
        availableBalance: result.availableBalance ?? 0,
        regimeAtEntry: pending.regime,
        timeFailBars: pending.timeFailBars,
        timeFailMinMfeR: pending.timeFailMinMfeR,
        minTp1R: pending.minTp1R
      });
    }

    log('info', `POSITION OPENED: ${symbol} ${pending.side.toUpperCase()}`, {
      entryMode: pending.entryMode,
      signalPrice: pending.entryPrice,
      entryPrice: currentPrice,
      fillDrift,
      fillDriftPct,
      entryQuality,
      standardSlippageTolerance,
      breakoutSlippageTolerance,
      slippageTolerance,
      stopLoss: pending.stopLossPrice,
      takeProfit1: pending.takeProfit1Price,
      takeProfit2: pending.takeProfit2Price,
      quantity: pending.quantity,
      balance: result.balance
    });
    const telegramMessage = formatOpenPositionMessage(
      pending.symbol,
      pending.side,
      pending.entryMode,
      pending.entryPrice,
      currentPrice,
      pending.quantity,
      pending.positionSize,
      pending.stopLossPrice,
      pending.takeProfit1Price,
      balanceBefore,
      balanceAfter,
      pending.regime,
      pending.initialR,
      pending.minTp1R
    );
    await sendTelegramMessage(telegramMessage);
  } catch (error) {
    log('error', `Error executing signal for ${symbol}`, {
      entryMode: pending.entryMode,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function runPositionMonitorCycle() {
  if (isPositionMonitorRunning) return;
  isPositionMonitorRunning = true;
  try {
    const now = nowMs();
    const positions = getAllPositions();
    if (positions.length === 0) return;
    const { minutes } = getMarketTimeParts(now);
    const forceCloseStartMinutes = 23 * 60 + 48;
    const sessionEndMinutes = 23 * 60 + 49;
    const shouldForceCloseSession = minutes >= forceCloseStartMinutes && minutes <= sessionEndMinutes;
    const monitorWindowOpen = isMonitorWindowOpen(now);
    if (AUTO_BOT_CONFIG.tradingHoursEnabled && !monitorWindowOpen && !shouldForceCloseSession) {
      log('warn', 'Positions remain while monitor window is closed', {
        nowMsk: formatMskTime(now),
        positions: positions.map(position => ({
          symbol: position.symbol,
          side: position.side,
          entryPrice: position.entryPrice,
          takeProfitPrice: position.takeProfitPrice,
          stopLossPrice: position.stopLossPrice
        }))
      });
      return;
    }

    for (const position of positions) {
      try {
        const symbol = getPositionKey(position.symbol);
        if (!symbol) {
          log('warn', `Skipping unsupported position symbol ${position.symbol}`);
          continue;
        }

        const currentPrice = await getCurrentPrice(symbol);
        const runtime = breakoutRuntimeState.get(symbol);
        if (shouldForceCloseSession) {
          const balanceBefore = getBalance();
          const result = closePosition(position.symbol, currentPrice, 'session_close');
          if (!result.ok) {
            log('error', `Failed to close ${position.symbol} at session end`, { reason: 'session_close', message: result.message });
            continue;
          }

          breakoutRuntimeState.delete(symbol);
          const balanceAfter = getBalance();
          const closedTrade = result.lastClosedTrade;
          if (AUTO_BOT_CONFIG.logTrades && closedTrade) {
            logTrade({
              timestamp: formatTime(nowMs()),
              symbol: position.symbol,
              side: position.side,
              entryMode: 'breakout_entry',
              action: 'close',
              entryPrice: position.entryPrice,
              exitPrice: currentPrice,
              stopLoss: position.stopLossPrice,
              takeProfit: position.takeProfitPrice,
              quantity: position.quantity,
              realizedPnL: closedTrade.realizedPnL,
              reason: 'session_close',
              regime: runtime?.regimeAtEntry ?? 'unknown',
              regimeAtEntry: runtime?.regimeAtEntry ?? 'unknown',
              balanceBefore,
              balanceAfter,
              totalCommission: closedTrade.totalCommission
            });
          }

          log('warn', `SESSION CLOSE: ${position.symbol} ${position.side.toUpperCase()}`, { exitPrice: currentPrice, reason: 'session_close', balanceAfter });
          if (closedTrade) {
            await sendTelegramMessage(formatClosePositionMessage(
              position.symbol,
              position.side,
              position.entryPrice,
              currentPrice,
              position.quantity,
              closedTrade.realizedPnL,
              'session_close',
              balanceBefore,
              balanceAfter,
              closedTrade.totalCommission
            ));
          }

          continue;
        }

        const candles5m = await loadClosed5mCandles(symbol);
        const lastClosedCandle = candles5m.at(-1);
        if (!lastClosedCandle) {
          log('warn', `${position.symbol}: no closed 5m candle available for exit monitoring`);
          continue;
        }

        const candleExitReason = getExitReasonFromCandle(position, lastClosedCandle);
        const quoteExitReason: 'take_profit' | 'stop_loss' | null =
          position.side === 'long'
            ? currentPrice <= position.stopLossPrice ? 'stop_loss' : currentPrice >= position.takeProfitPrice ? 'take_profit' : null
            : currentPrice >= position.stopLossPrice ? 'stop_loss' : currentPrice <= position.takeProfitPrice ? 'take_profit' : null;
        const exitReason = candleExitReason ?? quoteExitReason;
        if (exitReason) {
          const stopDistance = Math.abs(position.entryPrice - position.stopLossPrice);
          const triggerOvershoot = exitReason !== 'stop_loss' ? 0 :
            position.side === 'long' ? position.stopLossPrice - currentPrice : currentPrice - position.stopLossPrice;
          const triggerOvershootR = exitReason === 'stop_loss' && stopDistance > 0 ? triggerOvershoot / stopDistance : 0;
          log('warn', `EXIT TRIGGERED: ${position.symbol} ${position.side.toUpperCase()}`, {
            reason: exitReason,
            entryPrice: position.entryPrice,
            plannedStop: position.stopLossPrice,
            plannedTakeProfit: position.takeProfitPrice,
            observedExitPrice: currentPrice,
            candleTime: formatTime(candleOpenTimeMs(lastClosedCandle) ?? nowMs()),
            candleOpen: lastClosedCandle.open,
            candleHigh: lastClosedCandle.high,
            candleLow: lastClosedCandle.low,
            candleClose: lastClosedCandle.close,
            candleExitReason,
            quoteExitReason,
            triggerOvershoot,
            triggerOvershootR,
            monitorIntervalMs: AUTO_BOT_CONFIG.positionMonitorIntervalMs,
            detectedAt: formatTime(nowMs())
          });
          const balanceBefore = getBalance();
          const result = closePosition(position.symbol, currentPrice, exitReason);
          if (!result.ok) {
            log('warn', `Failed to close ${position.symbol}`, { reason: exitReason, message: result.message });
            continue;
          }

          breakoutRuntimeState.delete(symbol);
          const balanceAfter = getBalance();
          const closedTrade = result.lastClosedTrade;
          if (AUTO_BOT_CONFIG.logTrades && closedTrade) {
            logTrade({
              timestamp: formatTime(nowMs()),
              symbol: position.symbol,
              side: position.side,
              entryMode: 'breakout_entry',
              action: 'close',
              entryPrice: position.entryPrice,
              exitPrice: currentPrice,
              stopLoss: position.stopLossPrice,
              takeProfit: position.takeProfitPrice,
              quantity: position.quantity,
              realizedPnL: closedTrade.realizedPnL,
              reason: exitReason,
              regime: runtime?.regimeAtEntry ?? 'unknown',
              regimeAtEntry: runtime?.regimeAtEntry ?? 'unknown',
              initialR: runtime?.initialR?.toFixed(4) ?? Math.abs(position.entryPrice - position.stopLossPrice).toFixed(4),
              barsHeld5m: runtime ? getTimeFailState(runtime, candles5m, nowMs()).barsElapsed : undefined,
              maxFavorableExcursionR: runtime?.maxFavorableExcursionR,
              balanceBefore,
              balanceAfter,
              totalCommission: closedTrade.totalCommission
            });
          }

          log('info', `POSITION CLOSED: ${position.symbol} ${position.side.toUpperCase()} @ ${currentPrice} (${exitReason.toUpperCase()})`, {
            pnl: closedTrade?.realizedPnL?.toFixed(2),
            triggerOvershoot: exitReason === 'stop_loss' ? triggerOvershoot.toFixed(6) : '0',
            triggerOvershootR: exitReason === 'stop_loss' ? triggerOvershootR.toFixed(4) : '0',
            balance: result.balance
          });
          if (closedTrade) {
            await sendTelegramMessage(formatClosePositionMessage(
              position.symbol,
              position.side,
              position.entryPrice,
              currentPrice,
              position.quantity,
              closedTrade.realizedPnL,
              exitReason,
              balanceBefore,
              balanceAfter,
              closedTrade.totalCommission
            ));
          }

          continue;
        }

        if (runtime) {
          const timeFail = getTimeFailState(runtime, candles5m, nowMs());
          log('info', `BREAKOUT TIME-FAIL CHECK: ${position.symbol}`, {
            side: position.side,
            regimeAtEntry: runtime.regimeAtEntry,
            openedAt: formatTime(runtime.openedAt),
            signalCandleTime: formatTime(runtime.signalCandleTime),
            barsElapsed: timeFail.barsElapsed,
            newlyProcessedBars: timeFail.newlyProcessedBars,
            requiredBars: runtime.timeFailBars,
            maxFavorableExcursionR: timeFail.maxFavorableExcursionR,
            minRequiredMfeR: runtime.timeFailMinMfeR,
            processedCandleTimes: [...runtime.processedCandleTimes].map(formatTime),
            failed: timeFail.failed
          });
          if (timeFail.failed) {
            const balanceBefore = getBalance();
            const result = closePosition(position.symbol, currentPrice, 'breakout_time_fail');
            if (!result.ok) {
              log('warn', `Failed to close ${position.symbol} by breakout time-fail`, {
                reason: 'breakout_time_fail',
                message: result.message,
                barsElapsed: timeFail.barsElapsed,
                maxFavorableExcursionR: timeFail.maxFavorableExcursionR,
                minRequiredMfeR: runtime.timeFailMinMfeR
              });
              continue;
            }

            breakoutRuntimeState.delete(symbol);
            const balanceAfter = getBalance();
            const closedTrade = result.lastClosedTrade;
            if (AUTO_BOT_CONFIG.logTrades && closedTrade) {
              logTrade({
                timestamp: formatTime(nowMs()),
                symbol: position.symbol,
                side: position.side,
                entryMode: 'breakout_entry',
                action: 'close',
                entryPrice: position.entryPrice,
                exitPrice: currentPrice,
                stopLoss: position.stopLossPrice,
                takeProfit: position.takeProfitPrice,
                quantity: position.quantity,
                realizedPnL: closedTrade.realizedPnL,
                reason: 'breakout_time_fail',
                regime: runtime.regimeAtEntry,
                regimeAtEntry: runtime.regimeAtEntry,
                initialR: runtime.initialR.toFixed(4),
                barsHeld5m: timeFail.barsElapsed,
                maxFavorableExcursionR: timeFail.maxFavorableExcursionR,
                timeFailBars: runtime.timeFailBars,
                timeFailMinMfeR: runtime.timeFailMinMfeR,
                balanceBefore,
                balanceAfter,
                totalCommission: closedTrade.totalCommission
              });
            }

            log('warn', `BREAKOUT TIME FAIL: ${position.symbol} ${position.side.toUpperCase()}`, {
              reason: 'breakout_time_fail',
              currentPrice,
              barsElapsed: timeFail.barsElapsed,
              requiredBars: runtime.timeFailBars,
              maxFavorableExcursionR: timeFail.maxFavorableExcursionR,
              minRequiredMfeR: runtime.timeFailMinMfeR,
              regimeAtEntry: runtime.regimeAtEntry
            });
            if (closedTrade) {
              await sendTelegramMessage(formatClosePositionMessage(
                position.symbol,
                position.side,
                position.entryPrice,
                currentPrice,
                position.quantity,
                closedTrade.realizedPnL,
                'breakout_time_fail',
                balanceBefore,
                balanceAfter,
                closedTrade.totalCommission
              ));
            }
          }
        }
      } catch (error) {
        log('error', `Monitor error for ${position.symbol}`, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } finally {
    isPositionMonitorRunning = false;
  }
}

let oneMinuteTriggerInterval: NodeJS.Timeout | null = null;

async function runOneMinuteTriggerCycle() {
  const now = nowMs();
  if (!isMonitorWindowOpen(now)) return;
  const pendingList = Array.from(pendingSignals.entries());
  if (pendingList.length === 0) return;
  for (const [symbol, pending] of pendingList) {
    try {
      const currentPrice = await getCurrentPrice(symbol);
      const baseTolerance = 0.001;
      const lastAtr = pending.lastAtr > 0 ? pending.lastAtr : 0;
      const atrTolerance = lastAtr > 0 && pending.entryPrice > 0 ? lastAtr / pending.entryPrice : 0;
      const breakoutSlippageTolerance = Math.max(baseTolerance + 0.5 * atrTolerance, 1.25 * atrTolerance);
      const slippageTolerance = pending.entryMode === 'breakout_entry' ? breakoutSlippageTolerance : baseTolerance + 0.5 * atrTolerance;
      const priceDiff = Math.abs(currentPrice - pending.entryPrice) / pending.entryPrice;
      if (priceDiff > slippageTolerance) {
        log('info', `${symbol}: 1m trigger skipped, price moved too far`, { side: pending.side, signalPrice: pending.entryPrice, currentPrice, priceDiff });
        continue;
      }

      const stillBeyondBreakout =
        pending.side === 'long'
          ? currentPrice > pending.breakoutLevel
          : currentPrice < pending.breakoutLevel;

      if (!stillBeyondBreakout) {
        log('info', `${symbol}: 1m trigger breakout invalidated`, {
          side: pending.side,
          currentPrice,
          breakoutLevel: pending.breakoutLevel
        });
        pendingSignals.delete(symbol);
        continue;
      }

      const actualInitialR = Math.abs(currentPrice - pending.stopLossPrice);
      const actualTp1Distance = pending.side === 'long' ? pending.takeProfit1Price - currentPrice : currentPrice - pending.takeProfit1Price;
      const actualTp1R = actualInitialR > 0 ? actualTp1Distance / actualInitialR : 0;
      const minTp1R = pending.minTp1R ?? BREAKOUT_MIN_TP1_R;
      if (!Number.isFinite(actualTp1R) || actualTp1R < minTp1R) {
        log('warn', `${symbol}: 1m trigger cancelled by actual TP1/R`, { side: pending.side, signalPrice: pending.entryPrice, executionPrice: currentPrice, actualTp1R, minTp1R });
        pendingSignals.delete(symbol);
        continue;
      }

      const result = openPosition({
        symbol: pending.symbol,
        side: pending.side,
        entryPrice: currentPrice,
        takeProfitPrice: pending.takeProfit1Price,
        stopLossPrice: pending.stopLossPrice,
        quantity: pending.quantity,
        entryMode: pending.entryMode,
        regimeAtEntry: pending.regime,
        initialR: actualInitialR,
        timeFailBars: pending.timeFailBars,
        timeFailMinMfeR: pending.timeFailMinMfeR,
        minTp1R: pending.minTp1R,
        signalCandleTime: pending.signalCandleTime
      });
      if (!result.ok) {
        log('warn', `Failed to open position for ${symbol} via 1m trigger`, { entryMode: pending.entryMode, message: result.message });
        continue;
      }

      pendingSignals.delete(symbol);
      const openedAt = nowMs();
      const signalCandleTime = floorToBar(pending.signalCandleTime, timeframeToMs(AUTO_BOT_CONFIG.timeframe));
      breakoutRuntimeState.set(symbol, {
        symbol,
        side: pending.side,
        entryPrice: currentPrice,
        stopLossPrice: pending.stopLossPrice,
        takeProfitPrice: pending.takeProfit1Price,
        initialR: actualInitialR,
        regimeAtEntry: pending.regime,
        openedAt,
        signalCandleTime,
        timeFailBars: pending.timeFailBars,
        timeFailMinMfeR: pending.timeFailMinMfeR,
        processedCandleTimes: new Set(),
        maxFavorableExcursionR: 0
      });
      const balanceBefore = getBalance();
      const balanceAfter = getBalance();
      if (AUTO_BOT_CONFIG.logTrades) {
        logTrade({
          timestamp: formatTime(nowMs()),
          symbol: pending.symbol,
          side: pending.side,
          entryMode: pending.entryMode,
          action: 'open',
          entryPrice: currentPrice,
          stopLoss: pending.stopLossPrice,
          takeProfit: pending.takeProfit1Price,
          quantity: pending.quantity,
          positionSize: pending.positionSize,
          regime: pending.regime,
          initialR: actualInitialR.toFixed(4),
          balanceBefore,
          balanceAfter,
          availableBalance: result.availableBalance ?? 0,
          regimeAtEntry: pending.regime,
          timeFailBars: pending.timeFailBars,
          timeFailMinMfeR: pending.timeFailMinMfeR,
          minTp1R: pending.minTp1R
        });
      }

      log('info', `POSITION OPENED (1m trigger): ${symbol} ${pending.side.toUpperCase()}`, {
        entryMode: pending.entryMode,
        signalPrice: pending.entryPrice,
        entryPrice: currentPrice,
        stopLoss: pending.stopLossPrice,
        takeProfit1: pending.takeProfit1Price,
        quantity: pending.quantity,
        balance: result.balance
      });
      const telegramMessage = formatOpenPositionMessage(
        pending.symbol,
        pending.side,
        pending.entryMode,
        pending.entryPrice,
        currentPrice,
        pending.quantity,
        pending.positionSize,
        pending.stopLossPrice,
        pending.takeProfit1Price,
        balanceBefore,
        balanceAfter,
        pending.regime,
        pending.initialR,
        pending.minTp1R
      );
      await sendTelegramMessage(telegramMessage);
    } catch (error) {
      log('error', `Error in 1m trigger for ${symbol}`, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function scheduleOneMinuteTrigger() {
  oneMinuteTriggerInterval = setInterval(() => {
    runOneMinuteTriggerCycle().catch(error => {
      log('error', '1m trigger cycle error', { error: error instanceof Error ? error.message : String(error) });
    });
  }, AUTO_BOT_CONFIG.oneMinuteTriggerIntervalMs);
}

let regimeTimer: NodeJS.Timeout | null = null;
let monitorInterval: NodeJS.Timeout | null = null;

function scheduleNextRegimeCycle() {
  const delay = computeRegimeDelayMs();
  log('info', 'Next 5m entry cycle scheduled', {
    at: formatTime(nowMs() + delay),
    delayMs: delay,
    entryTimeframe: AUTO_BOT_CONFIG.timeframe,
    contextTimeframe: AUTO_BOT_CONFIG.contextTimeframe
  });
  regimeTimer = setTimeout(() => {
    runRegimeCheckCycle()
      .catch(error => {
        log('error', 'Regime cycle error', { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(scheduleNextRegimeCycle);
  }, delay);
}

export async function startAutoBot() {
  log('info', 'Starting auto-bot...', { config: maskedConfig() });
  if (AUTO_BOT_CONFIG.telegramEnabled) await sendTelegramTestMessage();
  await notifySessionStateIfChanged(nowMs());
  runRegimeCheckCycle().catch(error => {
    log('error', 'Initial regime check failed', { error: error instanceof Error ? error.message : String(error) });
  });
  scheduleNextRegimeCycle();
  monitorInterval = setInterval(() => {
    runPositionMonitorCycle().catch(error => {
      log('error', 'Monitor cycle error', { error: error instanceof Error ? error.message : String(error) });
    });
  }, AUTO_BOT_CONFIG.positionMonitorIntervalMs);
  scheduleOneMinuteTrigger();
  log('info', 'Auto-bot started', {
    entryTimeframe: AUTO_BOT_CONFIG.timeframe,
    contextTimeframe: AUTO_BOT_CONFIG.contextTimeframe,
    htfTimeframe: '1h',
    maxPositions: AUTO_BOT_CONFIG.maxPositions,
    maxRiskPerTrade: '3%',
    positionSizeFraction: '30%',
    telegramSignalChecksEnabled: AUTO_BOT_CONFIG.telegramSignalChecksEnabled,
    telegramSessionNotificationsEnabled: AUTO_BOT_CONFIG.telegramSessionNotificationsEnabled
  });
}

export function stopAutoBot() {
  if (regimeTimer) clearTimeout(regimeTimer);
  if (monitorInterval) clearInterval(monitorInterval);
  if (oneMinuteTriggerInterval) clearInterval(oneMinuteTriggerInterval);
  regimeTimer = null;
  monitorInterval = null;
  oneMinuteTriggerInterval = null;
  log('info', 'Auto-bot stopped');
}

export function getAutoBotStatus() {
  return {
    running: Boolean(regimeTimer),
    config: maskedConfig(),
    entryTimeframe: AUTO_BOT_CONFIG.timeframe,
    contextTimeframe: AUTO_BOT_CONFIG.contextTimeframe,
    htfTimeframe: '1h',
    sessionState: getSessionState(nowMs()),
    openPositions: getAllPositions().map(position => ({
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      quantity: position.quantity,
      notional: position.notional,
      takeProfitPrice: position.takeProfitPrice,
      stopLossPrice: position.stopLossPrice,
      openedAt: position.openedAt,
      unrealizedPnL: 0
    })),
    pendingSignals: Array.from(pendingSignals.entries()).map(([symbol, signal]) => ({
      symbol,
      side: signal.side,
      entryMode: signal.entryMode,
      entryPrice: signal.entryPrice,
      stopLossPrice: signal.stopLossPrice,
      takeProfit1Price: signal.takeProfit1Price,
      takeProfit2Price: signal.takeProfit2Price,
      barsWaited: signal.barsWaited,
      timeoutBars: AUTO_BOT_CONFIG.entryTimeoutBars,
      entryTimeframe: '5m'
    })),
    telegramSignalChecksEnabled: AUTO_BOT_CONFIG.telegramSignalChecksEnabled,
    telegramSessionNotificationsEnabled: AUTO_BOT_CONFIG.telegramSessionNotificationsEnabled,
    balance: getBalance(),
    availableBalance: getAvailableBalance()
  };
}
