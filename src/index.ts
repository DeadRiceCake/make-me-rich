import axios from 'axios';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';

dotenv.config();

// BitGet API 설정
const API_URL = 'https://api.bitget.com';
const API_KEY = 'YOUR_API_KEY';
const SECRET_KEY = 'YOUR_SECRET_KEY';
const PASSPHRASE = 'YOUR_PASSPHRASE';

// 서명 생성 함수 (HMAC SHA256)
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

// 인증 헤더 생성 함수
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
    locale: 'en-US',
  };
}

// 시장 티커 조회 (공개 API, 인증 불필요)
async function getTicker(symbol: string): Promise<any> {
  try {
    const response = await axios.get(
      `${API_URL}/api/spot/v1/market/ticker?symbol=${symbol}`,
    );
    return response.data.data;
  } catch (error) {
    console.error('Ticker 조회 오류:', error);
    throw error;
  }
}

// 계정 잔고 조회
async function getBalance(coin?: string): Promise<any> {
  const path = '/api/spot/v1/account/assets';
  const query = coin ? `coin=${coin}` : '';
  const headers = getAuthHeaders('GET', path, query);
  try {
    const response = await axios.get(
      `${API_URL}${path}${query ? '?' + query : ''}`,
      {headers},
    );
    return response.data.data;
  } catch (error) {
    console.error('잔고 조회 오류:', error);
    throw error;
  }
}

// 주문 배치 (limit 또는 market)
async function placeOrder(
  symbol: string,
  side: 'buy' | 'sell',
  orderType: 'limit' | 'market',
  price: string,
  quantity: string,
): Promise<any> {
  const path = '/api/spot/v1/trade/orders';
  const body = JSON.stringify({
    symbol,
    side,
    orderType,
    force: 'normal', // normal, post_only, fok, ioc 중 선택
    price: orderType === 'limit' ? price : undefined,
    quantity,
  });
  const headers = getAuthHeaders('POST', path, '', body);
  try {
    const response = await axios.post(`${API_URL}${path}`, body, {headers});
    return response.data.data;
  } catch (error) {
    console.error('주문 배치 오류:', error);
    throw error;
  }
}

// 자동 매매 로직 예시 (간단한 가격 기반 전략)
async function autoTrade() {
  const SYMBOL = 'BTCUSDT_SPBL'; // BitGet Spot 심볼 형식 (e.g., BTCUSDT_SPBL)
  const BUY_THRESHOLD = 30000; // 매수 임계값 (USD)
  const SELL_THRESHOLD = 40000; // 매도 임계값 (USD)
  const QUANTITY = '0.001'; // 매매 수량 (BTC)
  const LOOP_STATUS = true; // 무한 루프 상태

  while (LOOP_STATUS) {
    try {
      // 가격 조회
      const ticker = await getTicker(SYMBOL);
      const currentPrice = parseFloat(ticker.close);
      console.log(`현재 가격: ${currentPrice} USD`);

      // 잔고 확인
      const balance = await getBalance('USDT');
      const usdtAvailable = parseFloat(
        balance.find((b: any) => b.coinName === 'USDT')?.available || 0,
      );
      console.log(`USDT 잔고: ${usdtAvailable}`);

      if (
        currentPrice < BUY_THRESHOLD &&
        usdtAvailable > currentPrice * parseFloat(QUANTITY)
      ) {
        console.log('매수 조건 충족 - 매수 주문');
        await placeOrder(SYMBOL, 'buy', 'market', '', QUANTITY); // 시장가 매수
      } else if (currentPrice > SELL_THRESHOLD) {
        const btcBalance = await getBalance('BTC');
        const btcAvailable = parseFloat(
          btcBalance.find((b: any) => b.coinName === 'BTC')?.available || 0,
        );
        if (btcAvailable >= parseFloat(QUANTITY)) {
          console.log('매도 조건 충족 - 매도 주문');
          await placeOrder(SYMBOL, 'sell', 'market', '', QUANTITY); // 시장가 매도
        }
      }
    } catch (error) {
      console.error('자동 매매 오류:', error);
    }
    await new Promise(resolve => setTimeout(resolve, 60000)); // 1분 대기 (레이트 리밋 방지)
  }
}

// 봇 실행
autoTrade().catch(error => {
  console.error('자동 매매 봇 실행 오류:', error);
});
