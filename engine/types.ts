// Types for the Trading Scope application

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Trade {
  id: number;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  stopLoss: number | null;
  initialStopLoss?: number | null;
  takeProfit: number | null;
  slHistory?: Array<{ time: number; price: number }>;
  pnl: number;
  pnlPct: number;
  exitType: string;
}

export interface Metrics {
  net_profit: number;
  roi_pct: number;
  win_rate: number;
  profit_factor: number;
  max_drawdown: number;
  sharpe_ratio: number;
  total_trades: number;
  winners: number;
  losers: number;
  avg_win?: number;
  avg_loss?: number;
  long_trades?: number;
  short_trades?: number;
}

// BacktestMetrics for standalone backtest engine
export interface BacktestMetrics {
  total_trades: number;
  winners: number;
  losers: number;
  win_rate: number;
  net_profit: number;
  roi_pct: number;
  profit_factor: number;
  max_drawdown: number;
  sharpe_ratio: number;
  avg_win: number;
  avg_loss: number;
  total_fees: number;
}

export interface PeriodStats {
  month?: string;
  year?: string;
  week?: string;
  count: number;
  pnl: number;
  winners: number;
  losers: number;
  winRate: number;
  profitFactor?: number;
  maxDD?: number;
  roi?: number;
}

export interface PairStats {
  symbol: string;
  trades: number;
  pnl: number;
  winners: number;
  losers: number;
  winRate: number;
}

export interface EquityPoint {
  time: number;
  value: number;
}

export interface BacktestResult {
  success: boolean;
  meta: {
    strategy: string;
    generatedAt: string;
  };
  trades: Trade[];
  monthlyStats: PeriodStats[];
  yearlyStats: PeriodStats[];
  weeklyStats: PeriodStats[];
  pairStats: PairStats[];
  perPairStats?: PairStats[];
  total_trades: number;
  metrics: Metrics;
  equityCurve: EquityPoint[];
  plots: Record<string, unknown>;
  shapes: Record<string, unknown>;
  note?: string;
}

export interface Strategy {
  id: string;
  name: string;
  file: string;
  code: string;
}

export interface BacktestConfig {
  strategy?: string;
  code?: string;
  capital: number;
  feesPct: number;
  startDate?: string;
  endDate?: string;
  symbol?: string;
  candles?: Candle[];
  candlesBySymbol?: Record<string, Candle[]>;
}

export interface BacktestHistoryItem {
  id: string;
  strategyName: string;
  symbol: string;
  timeframe: string;
  roi: number;
  score: number;
  timestamp: number;
}

export interface BinanceKline {
  0: number;  // Open time
  1: string;  // Open
  2: string;  // High
  3: string;  // Low
  4: string;  // Close
  5: string;  // Volume
  6: number;  // Close time
  7: string;  // Quote asset volume
  8: number;  // Number of trades
  9: string;  // Taker buy base asset volume
  10: string; // Taker buy quote asset volume
  11: string; // Ignore
}

export interface ScoreBreakdown {
  total: number;
  resilience: number;
  efficiency: number;
  sharpe: number;
  sqn: number;
  consistency: number;
}

export interface AppState {
  // Chart state
  candles: Candle[];
  symbol: string;
  interval: string;
  isLoading: boolean;
  loadingText: string;
  
  // Multi-pair state
  selectedPairs: string[];
  candlesBySymbol: Record<string, Candle[]>;
  
  // Backtest state
  backtestResult: BacktestResult | null;
  strategies: Strategy[];
  selectedStrategy: string | null;
  strategyCode: string;
  backtestConfig: BacktestConfig;
  backtestHistory: BacktestHistoryItem[];
  
  // UI state
  activeTab: 'stats' | 'history';
  isLive: boolean;
  isReplaying: boolean;
  replayIndex: number;
  statsPanelWidth: number;
  tradeDrawerHeight: number;
  
  // Auth state
  isAuthenticated: boolean;
}

// API Response types
export interface ApiResponse<T> {
  success?: boolean;
  error?: string;
  data?: T;
}

export interface StrategiesResponse {
  strategies: Strategy[];
}

export interface BacktestsListResponse {
  backtests: Array<{
    filename: string;
    size: number;
    modified: string;
  }>;
}