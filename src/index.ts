import axios from 'axios';
import * as crypto from 'crypto';
import * as WebSocket from 'ws';
import * as dotenv from 'dotenv';

dotenv.config();

// BitGet API 설정 (REST용)
const API_URL = 'https://api.bitget.com';
const API_KEY = process.env.BITGET_API_KEY || 'YOUR_API_KEY';
const SECRET_KEY = process.env.BITGET_SECRET_KEY || 'YOUR_SECRET_KEY';
const PASSPHRASE = process.env.BITGET_PASSPHRASE || 'YOUR_PASSPHRASE';

const SYMBOL = 'SOLUSDT_UMCBL'; // Solana Perpetual
const LEVERAGE = 10;
const TIMEFRAME = '1m'; // 1분 캔들
const SHORT_MA_PERIOD = 50;
const LONG_MA_PERIOD = 200;
const QUANTITY = '1'; // SOL 수량
const TP_PCT = 0.005; // 0.5%
const SL_PCT = -0.003; // -0.3%
const MIN_CHANGE_PCT = 0.002; // 0.2%
const TAKER_FEE = 0.0006; // 0.06%

const PUBLIC_WS_URL = 'wss://wspap.bitget.com/v2/ws/public';
const PRIVATE_WS_URL = 'wss://wspap.bitget.com/v2/ws/private';

// 가격 배열 (실시간 캔들로 업데이트)
let prices: number[] = []; // 최근 종가 배열 (최대 LONG_MA_PERIOD 유지)
let currentPrice = 0;
let currentPosition: 'long' | 'short' | null = null;

// 서명 생성 (REST용)
function generateSignature(
  method: string,
  path: string,
  query = '',
  body = '',
): string {
  const timestamp = Date.now().toString();
  const preHash =
    timestamp + method.toUpperCase() + path + (query ? '?' + query : '') + body;
  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(preHash);
  return hmac.digest('base64');
}

// 인증 헤더 (REST용)
function getAuthHeaders(
  method: string,
  path: string,
  query = '',
  body = '',
): Record<string, string> {
  const timestamp = Date.now().toString();
  const sign = generateSignature(method, path, query, body);
  return {
    'ACCESS-KEY': API_KEY,
    'ACCESS-SIGN': sign,
    'ACCESS-TIMESTAMP': timestamp,
    'ACCESS-PASSPHRASE': PASSPHRASE,
    'Content-Type': 'application/json',
    paptrading: '1',
    locale: 'en-US',
  };
}

// 초기 캔들 로드 (WS 연결 전 과거 데이터)
async function loadInitialCandles() {
  const path = '/api/mix/v1/market/candles';
  const query = `symbol=${SYMBOL}&granularity=${TIMEFRAME}&limit=${LONG_MA_PERIOD}`;
  try {
    const response = await axios.get(`${API_URL}${path}?${query}`);
    prices = response.data.data.map((c: string[]) => parseFloat(c[4])); // 종가
    currentPrice = prices[prices.length - 1];
    console.log('초기 캔들 로드 완료');
  } catch (error) {
    console.error('초기 캔들 오류:', error);
  }
}

// SMA 계산
function calculateSMA(prices: number[], period: number): number {
  if (prices.length < period) return 0;
  const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
  return sum / period;
}

// 레버리지 설정 (REST)
async function setLeverage(
  symbol: string,
  leverage: number,
  marginCoin = 'USDT',
) {
  const path = '/api/mix/v1/position/setLeverage';
  const body = JSON.stringify({symbol, leverage, marginCoin, holdSide: 'long'});
  const headers = getAuthHeaders('POST', path, '', body);
  try {
    await axios.post(`${API_URL}${path}`, body, {headers});
    console.log(`레버리지 ${leverage}x 설정`);
  } catch (error) {
    console.error('레버리지 오류:', error);
  }
}

// 주문 배치 (REST, 시장가)
async function placeOrder(
  symbol: string,
  side: 'open_long' | 'open_short' | 'close_long' | 'close_short',
  quantity: string,
) {
  const path = '/api/mix/v1/order/placeOrder';
  const body = JSON.stringify({
    symbol,
    marginCoin: 'USDT',
    size: quantity,
    side,
    orderType: 'market',
    timeInForceValue: 'normal',
  });
  const headers = getAuthHeaders('POST', path, '', body);
  try {
    const response = await axios.post(`${API_URL}${path}`, body, {headers});
    console.log(`${side} 주문 완료`);
    return response.data.data;
  } catch (error) {
    console.error('주문 오류:', error);
    throw error;
  }
}

// TP/SL 설정 (REST)
async function setTP_SL(
  symbol: string,
  holdSide: 'long' | 'short',
  entryPrice: number,
) {
  const path = '/api/mix/v1/plan/placeTPSL';
  const tpPrice = entryPrice * (1 + (holdSide === 'long' ? TP_PCT : -TP_PCT));
  const slPrice = entryPrice * (1 + (holdSide === 'long' ? SL_PCT : -SL_PCT));
  const body = JSON.stringify({
    symbol,
    marginCoin: 'USDT',
    planType: 'normal_plan',
    triggerPrice: tpPrice.toFixed(2),
    triggerType: 'fill_price',
    size: QUANTITY,
    side: holdSide === 'long' ? 'close_long' : 'close_short',
    executePrice: '',
    triggerDirection: holdSide === 'long' ? 'rise' : 'fall',
    holdSide,
  });
  const headers = getAuthHeaders('POST', path, '', body);
  try {
    await axios.post(`${API_URL}${path}`, body, {headers});
    console.log('TP/SL 설정 완료');
  } catch (error) {
    console.error('TP/SL 오류:', error);
  }
}

// WebSocket 연결 함수 (공통)
function connectWS(
  url: string,
  isPrivate: boolean,
  onMessage: (data: any) => void,
  onOpen: () => void,
) {
  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log(`WS 연결: ${url}`);
    onOpen();
    setInterval(() => ws.send('ping'), 30000); // 30초 ping
  });

  ws.on('message', (data: string) => {
    if (data === 'pong') return;
    try {
      const msg = JSON.parse(data);
      onMessage(msg);
    } catch (error) {
      console.error('메시지 파싱 오류:', error);
    }
  });

  ws.on('close', () => {
    console.log('WS 연결 끊김 - 재연결 시도');
    setTimeout(() => connectWS(url, isPrivate, onMessage, onOpen), 1000);
  });

  ws.on('error', error => console.error('WS 오류:', error));

  return ws;
}

// Private WS 로그인 서명
function getLoginSign(timestamp: string): string {
  const preHash = timestamp + 'GET' + '/user/verify';
  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(preHash);
  return hmac.digest('base64');
}

// 자동 매매 로직
async function autoTrade() {
  await loadInitialCandles(); // 초기 데이터 로드
  await setLeverage(SYMBOL, LEVERAGE);

  // Public WS: 티커와 캔들 구독
  const publicWs = connectWS(
    PUBLIC_WS_URL,
    false,
    msg => {
      if (msg.arg?.channel === 'ticker') {
        currentPrice = parseFloat(msg.data[0]?.last || 0); // 실시간 가격 업데이트
      } else if (msg.arg?.channel === `candle${TIMEFRAME}`) {
        const newCandle = msg.data[0]; // [open, high, low, close, volume, ...]
        const newClose = parseFloat(newCandle[4]);
        prices.push(newClose);
        if (prices.length > LONG_MA_PERIOD) prices.shift(); // 배열 크기 유지
        console.log('캔들 업데이트:', newClose);
      }
    },
    () => {
      const subMsg = JSON.stringify({
        op: 'subscribe',
        args: [
          {instType: 'USDT-FUTURES', channel: 'ticker', instId: SYMBOL},
          {
            instType: 'USDT-FUTURES',
            channel: `candle${TIMEFRAME}`,
            instId: SYMBOL,
          },
        ],
      });
      publicWs.send(subMsg); // 구독
    },
  );

  // Private WS: 포지션 구독 및 로그인
  const privateWs = connectWS(
    PRIVATE_WS_URL,
    true,
    msg => {
      if (msg.event === 'login') {
        console.log('Private 로그인 성공');
      } else if (msg.arg?.channel === 'positions') {
        const posData = msg.data[0];
        currentPosition = posData?.holdSide || null;
        console.log('포지션 업데이트:', currentPosition);
      }
    },
    () => {
      const timestamp = Date.now().toString();
      const sign = getLoginSign(timestamp);
      const loginMsg = JSON.stringify({
        op: 'login',
        args: [{apiKey: API_KEY, passphrase: PASSPHRASE, timestamp, sign}],
      });
      privateWs.send(loginMsg); // 로그인

      const subMsg = JSON.stringify({
        op: 'subscribe',
        args: [
          {instType: 'USDT-FUTURES', channel: 'positions', instId: SYMBOL},
        ],
      });
      setTimeout(() => privateWs.send(subMsg), 1000); // 로그인 후 구독
    },
  );

  // 실시간 거래 로직 (10초 간격)
  setInterval(async () => {
    if (prices.length < LONG_MA_PERIOD || currentPrice === 0) return;

    const shortMA = calculateSMA(prices, SHORT_MA_PERIOD);
    const longMA = calculateSMA(prices, LONG_MA_PERIOD);
    const priceChange =
      (currentPrice - prices[prices.length - 2]) / prices[prices.length - 2];

    if (Math.abs(priceChange) >= MIN_CHANGE_PCT) {
      try {
        if (shortMA > longMA && currentPosition !== 'long') {
          if (currentPosition === 'short')
            await placeOrder(SYMBOL, 'close_short', QUANTITY);
          await placeOrder(SYMBOL, 'open_long', QUANTITY);
          await setTP_SL(SYMBOL, 'long', currentPrice);
          currentPosition = 'long';
          console.log('Long 포지션 오픈');
        } else if (shortMA < longMA && currentPosition !== 'short') {
          if (currentPosition === 'long')
            await placeOrder(SYMBOL, 'close_long', QUANTITY);
          await placeOrder(SYMBOL, 'open_short', QUANTITY);
          await setTP_SL(SYMBOL, 'short', currentPrice);
          currentPosition = 'short';
          console.log('Short 포지션 오픈');
        }

        if (currentPosition) {
          const feeAdjustedProfit = priceChange * LEVERAGE - TAKER_FEE * 2;
          console.log(
            `현재 포지션: ${currentPosition}, 조정 수익: ${feeAdjustedProfit.toFixed(4)}%`,
          );
        }
      } catch (error) {
        console.error('거래 오류:', error);
      }
    }
  }, 10000); // 10초 체크
}

// 봇 실행
autoTrade().catch(error => {
  console.error('봇 실행 중 오류:', error);
  throw new Error(`Bot execution failed: ${error.message || error}`);
});
