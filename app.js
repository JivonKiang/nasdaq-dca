// ============================================================
// 纳指定投助手 - 核心引擎
// ============================================================

// ===== 配置 =====
const CONFIG = {
  CORS_PROXIES: [
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url=',
    'https://api.codetabs.com/v1/proxy?quest=',
  ],
  YAHOO_BASE: 'https://query1.finance.yahoo.com',
  SYMBOLS: {
    NDX: '^NDX',      // Nasdaq-100
    VIX: '^VIX',      // VIX恐慌指数
    TNX: '^TNX',      // 10年期美债收益率
    SPY: 'SPY',       // S&P 500 ETF (用于对比)
    QQQ: 'QQQ',       // Nasdaq-100 ETF
  },
  CACHE_DURATION: 5 * 60 * 1000, // 5分钟缓存
  USE_MOCK: false, // 强制使用模拟数据（调试用）
  // GitHub缓存路径（与index.html同目录）
  GITHUB_CACHE_URL: './cache.json',
};

// ===== 用户设置（预填默认值）=====
let userSettings = {
  totalInvested: 0,       // 累计投入（元），你记账时会自动累计
  avgCost: 0,             // 持仓成本（每份均价），记账时自动计算
  currentValue: 0,        // 当前持仓市值，记账时自动更新
  startDate: '',          // 开始定投日期，首次记账时自动记录
  totalAssets: 650000,    // 总资产65万
  weeklyBase: 1000,       // 周四定投基准1000元
  holdings: 16,           // 15支纳指100 + 1支标普500 = 16支
};

// ===== 全局状态 =====
let marketData = null;
let lastFetchTime = 0;
let currentProxyIndex = 0;
let consecutiveAddDays = 0; // 连续加仓天数

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', async () => {
  loadSettings();

  // 速度优化：优先读GitHub缓存（秒开），再后台拉新数据
  try {
    const githubCache = await fetchGitHubCache();
    if (githubCache) {
      githubCache._source = 'github-cache';
      marketData = githubCache;
      renderAllTabs(githubCache);
      updateHeaderStatus(githubCache);
      document.getElementById('loadingState').style.display = 'none';
      // 后台静默尝试获取更新数据
      fetchAllMarketData().then(fresh => {
        if (fresh && !fresh._mock && !fresh._stale) {
          marketData = fresh;
          renderAllTabs(fresh);
          updateHeaderStatus(fresh);
        }
      }).catch(() => {});
      return; // 有缓存就不再走loading流程
    }
  } catch (e) {
    console.warn('GitHub cache fetch failed:', e);
  }

  // 无GitHub缓存，尝试localStorage缓存
  const localCached = loadCachedData();
  if (localCached) {
    localCached._source = 'local-cache';
    marketData = localCached;
    renderAllTabs(localCached);
    updateHeaderStatus(localCached);
    document.getElementById('loadingState').style.display = 'none';
    fetchAllMarketData().then(fresh => {
      if (fresh && !fresh._mock) {
        marketData = fresh;
        renderAllTabs(fresh);
        updateHeaderStatus(fresh);
      }
    }).catch(() => {});
    return;
  }

  // 完全无缓存，走完整加载
  refreshData();
});

// 读取GitHub上的cache.json
async function fetchGitHubCache() {
  try {
    const response = await fetch(CONFIG.GITHUB_CACHE_URL);
    if (!response.ok) return null;
    const data = await response.json();
    // 检查数据是否过期（超过2小时视为过期，但仍显示）
    const age = Date.now() - new Date(data.updatedAt || data.timestamp).getTime();
    if (age > 24 * 60 * 60 * 1000) return null; // 超过24小时不用
    // 解析nyTime为Date对象
    if (typeof data.nyTime === 'string') {
      data.nyTime = new Date(data.nyTime);
    }
    return data;
  } catch (e) {
    return null;
  }
}

// 渲染所有Tab的统一入口
function renderAllTabs(data) {
  const activeTab = document.querySelector('.tab-content.active');
  if (!activeTab) {
    document.getElementById('tab-today').classList.add('active');
  }
  renderTodayTab(data);
  renderShortTermTab(data);
  renderMidTermTab(data);
  renderLongTermTab(data);
  renderHistoryTab();
}

// 更新头部状态
function updateHeaderStatus(data) {
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const headerTime = document.getElementById('headerTime');

  if (data._mock) {
    statusBadge.className = 'status-badge loading';
    statusText.textContent = '演示数据';
  } else if (data._stale) {
    statusBadge.className = 'status-badge loading';
    statusText.textContent = '缓存数据';
  } else {
    statusBadge.className = 'status-badge live';
    statusText.textContent = '实时';
  }

  const nyTime = data.nyTime;
  const dataSource = data._mock ? ' [演示模式]' : data._stale ? ' [缓存模式]' : '';
  headerTime.textContent = `美东时间 ${formatTime(nyTime)} ${getDayName(nyTime.getDay())} | 更新于 ${formatTime(new Date())}${dataSource}`;
}

// ===== 数据获取层 =====

async function fetchViaProxy(url, timeoutMs = 6000) {
  // 尝试所有代理，每个有独立超时
  for (let i = 0; i < CONFIG.CORS_PROXIES.length; i++) {
    const proxyUrl = CONFIG.CORS_PROXIES[(currentProxyIndex + i) % CONFIG.CORS_PROXIES.length] + encodeURIComponent(url);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(proxyUrl, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (response.ok) {
        currentProxyIndex = (currentProxyIndex + i) % CONFIG.CORS_PROXIES.length;
        return await response.json();
      }
    } catch (e) {
      console.warn(`Proxy ${i} failed:`, e.message);
    }
  }
  throw new Error('所有代理均无法连接');
}

async function fetchChartData(symbol, range = '5d', interval = '1d') {
  const url = `${CONFIG.YAHOO_BASE}/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
  return fetchViaProxy(url);
}

async function fetchMultipleQuotes(symbols) {
  const url = `${CONFIG.YAHOO_BASE}/v8/finance/spark?symbols=${symbols.join(',')}&range=1d&interval=5m`;
  return fetchViaProxy(url);
}

// 获取PE数据 - 多数据源
async function fetchPEData() {
  // 方法1: 从QQQ的stats获取近似PE
  try {
    const data = await fetchChartData('QQQ', '1mo', '1d');
    const meta = data.chart?.result?.[0]?.meta;
    // Yahoo chart API 不直接给PE，需要用备用方案
  } catch (e) {
    console.warn('QQQ data fetch failed:', e);
  }

  // 方法2: 从Siblis Research获取
  try {
    const url = 'https://siblisresearch.com/data/nasdaq-100-pe-ratio/';
    const proxyUrl = CONFIG.CORS_PROXIES[currentProxyIndex] + encodeURIComponent(url);
    const response = await fetch(proxyUrl);
    if (response.ok) {
      const html = await response.text();
      // 解析HTML表格获取最新PE
      const peMatch = html.match(/([\d.]+)\s*<\/td>\s*<td[^>]*>[\d.]+\s*<\/td>\s*<td[^>]*>([\d.]+)\s*<\/td>/);
      if (peMatch) {
        return parseFloat(peMatch[2]);
      }
    }
  } catch (e) {
    console.warn('Siblis PE fetch failed:', e);
  }

  // 方法3: 使用内置的PE估算（基于NDX价格和已知PE关系）
  return null;
}

// ===== 主数据获取函数 =====

async function fetchAllMarketData() {
  const now = Date.now();

  // 如果强制使用模拟数据或缓存中有数据
  if (CONFIG.USE_MOCK) {
    return generateMockData();
  }

  // 尝试从缓存加载
  const cached = loadCachedData();
  if (cached && (now - cached.timestamp < CONFIG.CACHE_DURATION)) {
    return cached;
  }

  try {
    // 并行获取所有数据
    const [ndxData, vixData, tnxData, spyData] = await Promise.all([
      fetchChartData(CONFIG.SYMBOLS.NDX, '1mo', '1d'),
      fetchChartData(CONFIG.SYMBOLS.VIX, '5d', '1d'),
      fetchChartData(CONFIG.SYMBOLS.TNX, '5d', '1d'),
      fetchChartData(CONFIG.SYMBOLS.SPY, '1mo', '1d'),
    ]);

  // 解析NDX数据
  const ndxResult = ndxData.chart?.result?.[0];
  const ndxMeta = ndxResult?.meta;
  const ndxQuotes = ndxResult?.indicators?.quote?.[0];
  const timestamps = ndxResult?.timestamp || [];
  const closes = ndxQuotes?.close || [];

  // 获取最近20个交易日的收盘价（用于均线计算）
  const recentCloses = closes.filter(c => c !== null).slice(-20);
  const ma20 = recentCloses.length >= 20
    ? recentCloses.slice(-20).reduce((a, b) => a + b, 0) / 20
    : recentCloses.reduce((a, b) => a + b, 0) / recentCloses.length;

  // 解析VIX
  const vixMeta = vixData.chart?.result?.[0]?.meta;
  const vixQuotes = vixData.chart?.result?.[0]?.indicators?.quote?.[0];
  const vixCloses = vixQuotes?.close?.filter(c => c !== null) || [];

  // 解析10Y美债
  const tnxMeta = tnxData.chart?.result?.[0]?.meta;

  // 解析SPY
  const spyMeta = spyData.chart?.result?.[0]?.meta;
  const spyQuotes = spyData.chart?.result?.[0]?.indicators?.quote?.[0];
  const spyCloses = spyQuotes?.close?.filter(c => c !== null) || [];

  // 获取PE数据
  let pe = await fetchPEData();

  // 如果PE获取失败，使用估算
  if (!pe) {
    pe = estimatePE(ndxMeta?.regularMarketPrice);
  }

  // 计算近期高点
  const allCloses = closes.filter(c => c !== null);
  const recentHigh = Math.max(...allCloses.slice(-60)); // 60日内高点
  const drawdown = ((recentHigh - ndxMeta.regularMarketPrice) / recentHigh * 100);

  // 前一交易日涨跌幅
  const prevClose = ndxMeta?.chartPreviousClose || ndxMeta?.previousClose;
  const currentPrice = ndxMeta?.regularMarketPrice;
  const dailyChange = prevClose ? ((currentPrice - prevClose) / prevClose * 100) : 0;

  // 周涨跌幅
  const weekAgoCloses = allCloses.slice(-7, -1);
  const weekStart = weekAgoCloses.length > 0 ? weekAgoCloses[0] : allCloses[allCloses.length - 6] || currentPrice;
  const weeklyChange = ((currentPrice - weekStart) / weekStart * 100);

  // 判断交易日/非交易日
  const today = getNYTime();
  const dayOfWeek = today.getDay();
  const isTradingDay = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isThursday = dayOfWeek === 4;

  // 计算距周四天数
  let daysToThursday = (4 - dayOfWeek + 7) % 7;
  if (daysToThursday === 0 && isTradingDay) daysToThursday = 0;
  else if (daysToThursday === 0) daysToThursday = 7;

  // 股债性价比（简化：美债收益率 vs 标普收益率倒数）
  const spyYield = spyMeta?.regularMarketPrice ? 1 / (spyMeta.regularMarketPrice / 100) : 0;
  const bondYield = tnxMeta?.regularMarketPrice || 0;
  const equityBondRatio = bondYield > 0 ? (spyYield / bondYield).toFixed(2) : '--';

  // 获取历史PE数据用于趋势分析
  const historicalPE = generateHistoricalPE(pe, allCloses);

  marketData = {
    timestamp: now,
    nyTime: today,

    // 价格数据
    ndx: {
      price: currentPrice,
      prevClose: prevClose,
      change: dailyChange,
      weeklyChange: weeklyChange,
      high60d: recentHigh,
      drawdown: drawdown,
      ma20: ma20,
      ma20Direction: currentPrice > ma20 ? 'up' : 'down',
      recentCloses: allCloses.slice(-30),
      timestamps: timestamps.slice(-30),
    },

    // 估值
    pe: pe,
    peGrade: getPEGrade(pe),

    // 恐慌指标
    vix: vixCloses.length > 0 ? vixCloses[vixCloses.length - 1] : null,
    vixRecent: vixCloses.slice(-5),

    // 美债
    treasury10y: tnxMeta?.regularMarketPrice || null,

    // 股债性价比
    equityBondRatio: equityBondRatio,

    // 日期信息
    isTradingDay: isTradingDay,
    isThursday: isThursday,
    daysToThursday: daysToThursday,
    dayOfWeek: dayOfWeek,

    // 历史PE
    historicalPE: historicalPE,
  };

  lastFetchTime = now;
  saveCachedData(marketData);
  return marketData;

  } catch (err) {
    console.error('Fetch failed, trying fallback:', err);

    // 尝试使用过期缓存
    const staleCached = loadCachedData();
    if (staleCached) {
      console.log('Using stale cached data');
      staleCached._stale = true;
      return staleCached;
    }

    // 最终降级：使用模拟数据
    console.log('Using mock data as final fallback');
    const mockData = generateMockData();
    mockData._mock = true;
    return mockData;
  }
}

// ===== PE估算函数 =====
function estimatePE(price) {
  // 基于已知数据点进行线性插值估算
  // 数据点：(价格, PE) - 基于近期市场数据
  const knownPoints = [
    [18000, 28], [19000, 29], [20000, 30], [21000, 31],
    [22000, 32], [23000, 33], [24000, 34], [25000, 35],
    [20000, 30], [17000, 26], [16000, 25],
  ];

  if (!price) return 30; // 默认值

  // 找到最近的两个数据点进行插值
  knownPoints.sort((a, b) => a[0] - b[0]);

  for (let i = 0; i < knownPoints.length - 1; i++) {
    if (price >= knownPoints[i][0] && price <= knownPoints[i + 1][0]) {
      const ratio = (price - knownPoints[i][0]) / (knownPoints[i + 1][0] - knownPoints[i][0]);
      return knownPoints[i][1] + ratio * (knownPoints[i + 1][1] - knownPoints[i][1]);
    }
  }

  // 超出范围时外推
  if (price < knownPoints[0][0]) {
    return knownPoints[0][1] - (knownPoints[0][0] - price) / 1000;
  }
  const last = knownPoints[knownPoints.length - 1];
  return last[1] + (price - last[0]) / 1000;
}

// 生成模拟历史PE数据（用于长期趋势展示）
function generateHistoricalPE(currentPE, closes) {
  // 基于价格反推历史PE的近似值
  const currentPrice = closes[closes.length - 1] || 20000;
  return closes.slice(-60).map((c, i) => {
    const priceRatio = c / currentPrice;
    return Math.max(15, Math.min(50, currentPE * priceRatio * (0.9 + Math.random() * 0.2)));
  });
}

// ===== PE档位判定 =====
function getPEGrade(pe) {
  if (pe < 25) return { level: '加倍', amount: 2000, class: 'buy-double', color: 'green' };
  if (pe <= 28) return { level: '1.5倍', amount: 1500, class: 'buy-normal', color: 'blue' };
  if (pe <= 32) return { level: '正常', amount: 1000, class: 'buy-normal', color: 'blue' };
  if (pe <= 35) return { level: '半额', amount: 500, class: 'buy-half', color: 'yellow' };
  if (pe <= 40) return { level: '最低', amount: 300, class: 'buy-min', color: 'orange' };
  return { level: '暂停', amount: 0, class: 'buy-zero', color: 'red' };
}

// ===== 加仓判定（三步法）=====
function calculateAdditionalBuy(data) {
  if (!data.isTradingDay || data.isThursday) {
    return { shouldAdd: false, amount: 0, reason: data.isThursday ? '周四禁止加仓' : '今日非交易日' };
  }

  const change = data.ndx.change; // 前一交易日涨跌幅
  const pe = data.pe;
  const vix = data.vix;
  const weeklyChange = data.ndx.weeklyChange;

  // 第一步：跌幅判定
  let baseAmount = 0;
  let step1Reason = '';
  if (change >= 0 || change > -2) {
    baseAmount = 0;
    step1Reason = `前日涨跌幅${change >= 0 ? '+' : ''}${change.toFixed(2)}%，未触发加仓阈值`;
  } else if (change >= -4) {
    baseAmount = 500;
    step1Reason = `前日跌${change.toFixed(2)}%，触发500元档`;
  } else if (change >= -7) {
    baseAmount = 1000;
    step1Reason = `前日跌${change.toFixed(2)}%，触发1000元档`;
  } else {
    baseAmount = 1000;
    step1Reason = `前日跌${change.toFixed(2)}%，触发1000元档+极端超跌`;
  }

  if (baseAmount === 0) {
    return { shouldAdd: false, amount: 0, reason: step1Reason, step1: step1Reason };
  }

  // 第二步：估值修正
  let multiplier = 1;
  let step2Reason = 'PE在25-32区间，估值修正系数×1.0';
  if (pe < 25) {
    multiplier = 1.2;
    step2Reason = `PE=${pe.toFixed(1)}<25，估值修正×1.2`;
  } else if (pe > 35) {
    multiplier = 0.5;
    step2Reason = `PE=${pe.toFixed(1)}>35，估值修正×0.5`;
  } else if (pe > 32) {
    multiplier = 0.8;
    step2Reason = `PE=${pe.toFixed(1)}在32-35，估值修正×0.8`;
  }

  let adjustedAmount = Math.round(baseAmount * multiplier);

  // 第三步：事件降档
  let eventDowngrade = false;
  let eventReason = '无事件降档';
  let skipToday = false;

  // 检查一级事件前1日
  const upcomingEvents = getUpcomingEvents(5);
  const tomorrow = new Date(data.nyTime);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const majorEventTomorrow = upcomingEvents.find(e => {
    const eventDate = new Date(e.date);
    return eventDate.toDateString() === tomorrow.toDateString() && e.level === '一级';
  });
  if (majorEventTomorrow) {
    eventDowngrade = true;
    eventReason = `明日${majorEventTomorrow.name}，降一档`;
  }

  // VIX>30且周跌>5%
  if (vix > 30 && weeklyChange < -5) {
    eventDowngrade = true;
    eventReason = `VIX=${vix.toFixed(1)}>30且周跌${weeklyChange.toFixed(1)}%，降一档`;
  }

  // 黑天鹅
  if (change < -7) {
    skipToday = true;
    eventReason = `单日跌${change.toFixed(2)}%>7%，黑天鹅跳过`;
  }

  // 年末季末
  if (isYearEndQuarterEnd(data.nyTime)) {
    eventDowngrade = true;
    eventReason = '年末/季末最后2个交易日，降一档';
  }

  if (skipToday) {
    return {
      shouldAdd: false,
      amount: 0,
      reason: eventReason,
      step1: step1Reason,
      step2: step2Reason,
      step3: eventReason,
      extremeDrop: true,
    };
  }

  if (eventDowngrade) {
    if (adjustedAmount >= 1000) adjustedAmount = 500;
    else if (adjustedAmount >= 500) adjustedAmount = 0;
  }

  // 连续加仓检测
  if (adjustedAmount > 0) {
    consecutiveAddDays++;
    if (consecutiveAddDays >= 3) {
      return {
        shouldAdd: true,
        amount: adjustedAmount,
        reason: step1Reason + '；' + step2Reason + '；' + eventReason,
        step1: step1Reason,
        step2: step2Reason,
        step3: eventReason,
        warning: '短期超跌区间，严守标准不随意加码',
      };
    }
  } else {
    consecutiveAddDays = 0;
  }

  return {
    shouldAdd: adjustedAmount > 0,
    amount: adjustedAmount,
    reason: step1Reason + '；' + step2Reason + '；' + eventReason,
    step1: step1Reason,
    step2: step2Reason,
    step3: eventReason,
  };
}

// ===== 事件日历 =====
function getUpcomingEvents(days = 5) {
  const events = [];
  const today = new Date(getNYTime());

  // 已知的定期经济事件（2026年）
  // FOMC利率决议（通常为周三）
  const fomcDates = [
    '2026-01-28', '2026-03-18', '2026-05-06', '2026-06-17',
    '2026-07-29', '2026-09-16', '2026-11-04', '2026-12-16',
  ];

  // CPI发布日（通常为月中周二）
  const cpiDates = [
    '2026-01-15', '2026-02-12', '2026-03-11', '2026-04-14',
    '2026-05-13', '2026-06-11', '2026-07-15', '2026-08-12',
    '2026-09-10', '2026-10-14', '2026-11-11', '2026-12-10',
  ];

  // 非农就业数据（通常为每月第一个周五）
  const nonFarmDates = [
    '2026-01-09', '2026-02-06', '2026-03-06', '2026-04-03',
    '2026-05-01', '2026-06-05', '2026-07-03', '2026-08-07',
    '2026-09-04', '2026-10-02', '2026-11-06', '2026-12-04',
  ];

  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    const dateStr = formatDateStr(date);

    fomcDates.forEach(d => {
      if (d === dateStr) events.push({ date: d, name: 'FOMC利率决议', impact: 'neutral', level: '一级' });
    });
    cpiDates.forEach(d => {
      if (d === dateStr) events.push({ date: d, name: 'CPI通胀数据', impact: 'neutral', level: '一级' });
    });
    nonFarmDates.forEach(d => {
      if (d === dateStr) events.push({ date: d, name: '非农就业数据', impact: 'neutral', level: '一级' });
    });
  }

  // 按日期排序
  events.sort((a, b) => new Date(a.date) - new Date(b.date));

  // 如果没有事件
  if (events.length === 0) {
    return [{ date: formatDateStr(new Date(today)), name: '近5日数据真空期', impact: 'neutral', level: '无' }];
  }

  return events;
}

function isYearEndQuarterEnd(date) {
  const month = date.getMonth(); // 0-indexed
  const day = date.getDate();
  // 12月末最后2个交易日、3/6/9月末最后2个交易日
  const lastDay = new Date(date.getFullYear(), month + 1, 0).getDate();
  return (month === 11 && day >= lastDay - 2) ||
         ([2, 5, 8].includes(month) && day >= lastDay - 2);
}

// ===== 趋势判断 =====
function analyzeTrend(data) {
  const price = data.ndx.price;
  const ma20 = data.ndx.ma20;
  const drawdown = data.ndx.drawdown;
  const pe = data.pe;

  let trend = '';
  let trendEmoji = '';
  let advice = '';

  if (price > ma20 * 1.05) {
    trend = '强势上涨';
    trendEmoji = '🚀';
    advice = '趋势向上，按正常档位执行定投。不追高加仓。';
  } else if (price > ma20) {
    trend = '温和上涨';
    trendEmoji = '📈';
    advice = '价格在均线上方运行，定投按标准执行。';
  } else if (price > ma20 * 0.95) {
    trend = '横盘震荡';
    trendEmoji = '↔️';
    advice = '价格在均线附近震荡，坚持定投收集筹码。';
  } else if (price > ma20 * 0.9) {
    trend = '回调修正';
    trendEmoji = '📉';
    advice = '价格低于均线，逢低加仓机会。关注PE档位。';
  } else {
    trend = '明显下跌';
    trendEmoji = '⬇️';
    advice = '价格大幅低于均线，严格执行加仓规则，不恐慌卖出。';
  }

  return { trend, trendEmoji, advice, drawdown, ma20 };
}

// ===== 数据说服 =====
function generateDataPersuasion(data) {
  const pe = data.pe;
  const totalAssets = userSettings.totalAssets;
  const weeklyAmount = data.peGrade.amount;
  const weeklyRatio = ((weeklyAmount / totalAssets) * 100).toFixed(4);

  // 历史定投收益概率（基于PE起点）
  let prob12m = '70%';
  let maxDrawdownPct = '15%';
  let startPE = pe;

  if (pe < 25) {
    prob12m = '85%';
    maxDrawdownPct = '10%';
  } else if (pe <= 28) {
    prob12m = '78%';
    maxDrawdownPct = '12%';
  } else if (pe <= 32) {
    prob12m = '70%';
    maxDrawdownPct = '15%';
  } else if (pe <= 35) {
    prob12m = '60%';
    maxDrawdownPct = '20%';
  } else {
    prob12m = '50%';
    maxDrawdownPct = '25%';
  }

  const maxLoss = Math.round(userSettings.totalInvested * parseFloat(maxDrawdownPct) / 100);
  const lossRatio = ((maxLoss / totalAssets) * 100).toFixed(2);

  return {
    weeklyRatio,
    prob12m,
    maxDrawdownPct,
    maxLoss,
    lossRatio,
    startPE: pe.toFixed(1),
  };
}

// ===== UI渲染层 =====

function renderTodayTab(data) {
  const tab = document.getElementById('tab-today');
  const pe = data.pe;
  const grade = data.peGrade;
  const addResult = calculateAdditionalBuy(data);
  const trend = analyzeTrend(data);
  const persuasion = generateDataPersuasion(data);
  const events = getUpcomingEvents(5);

  // PE仪表盘百分比
  const pePercent = Math.min(100, Math.max(0, ((pe - 15) / 35) * 100));

  // PE仪表盘颜色
  let gaugeColor = 'var(--accent-green)';
  if (pe > 28) gaugeColor = 'var(--accent-blue)';
  if (pe > 32) gaugeColor = 'var(--accent-yellow)';
  if (pe > 35) gaugeColor = 'var(--accent-orange)';
  if (pe > 40) gaugeColor = 'var(--accent-red)';

  const changeClass = data.ndx.change >= 0 ? 'green' : 'red';
  const changeSign = data.ndx.change >= 0 ? '+' : '';

  // 事件降档标记
  const eventDowngrade = addResult.step3 && addResult.step3 !== '无事件降档';

  // 连续加仓警告
  const consecutiveWarning = addResult.warning || '';

  // 非交易日提示
  const nonTradingNote = !data.isTradingDay
    ? `<div class="alert-banner info">📅 今日非交易日，下次操作窗口为周四（${data.daysToThursday}天后）</div>`
    : '';

  // 周四提示
  const thursdayNote = data.isThursday
    ? `<div class="alert-banner info">📌 今天是周四，执行定投日。全天禁止加仓。</div>`
    : '';

  // 极端超跌警告
  const extremeWarning = addResult.extremeDrop
    ? `<div class="alert-banner danger">🚨 极端超跌！单日跌幅超7%，今日跳过加仓</div>`
    : '';

  // 连续加仓警告
  const consecutiveAlert = consecutiveWarning
    ? `<div class="alert-banner warning">⚠️ ${consecutiveWarning}</div>`
    : '';

  // 事件列表HTML
  const eventsHTML = events.map(e => {
    const impactClass = e.impact === 'bullish' ? 'bullish' : e.impact === 'bearish' ? 'bearish' : 'neutral';
    const impactText = e.impact === 'bullish' ? '利好' : e.impact === 'bearish' ? '利空' : '中性';
    const dateObj = new Date(e.date + 'T12:00:00');
    const dateText = `${dateObj.getMonth() + 1}月${dateObj.getDate()}日`;
    return `
      <div class="event-item">
        <span class="event-date">${dateText}</span>
        <div style="flex:1">
          <div class="event-name">${e.name}</div>
        </div>
        <span class="event-impact ${impactClass}">${impactText}</span>
      </div>
    `;
  }).join('');

  tab.innerHTML = `
    ${nonTradingNote}
    ${thursdayNote}
    ${extremeWarning}
    ${consecutiveAlert}

    <!-- 心理锚点 -->
    <div class="card">
      <div class="card-title"><span class="emoji">🧠</span>心理锚点</div>
      <div style="font-size:14px;line-height:1.8;color:var(--text-secondary)">
        今日PE=<span class="${grade.color}" style="font-weight:700">${pe.toFixed(1)}</span>倍（<span class="${grade.color}">${grade.level}</span>档）。
        纳指长期PE中枢约25-28倍。
        你每周定投占${(userSettings.totalAssets / 10000).toFixed(0)}万总资产仅<span class="${grade.color}" style="font-weight:700">${persuasion.weeklyRatio}%</span>，
        即便全亏也不影响生活。
        <strong style="color:var(--text-primary)">浮亏是假的，份额是真的。</strong>
      </div>
    </div>

    <!-- 环境快照 -->
    <div class="card">
      <div class="card-title"><span class="emoji">📊</span>环境快照</div>
      <div class="data-grid">
        <div class="data-item">
          <div class="data-label">纳指收盘</div>
          <div class="data-value">${data.ndx.price?.toFixed(0) || '--'}</div>
          <div class="data-sub ${changeClass}">${changeSign}${data.ndx.change?.toFixed(2)}%</div>
        </div>
        <div class="data-item">
          <div class="data-label">PE（市盈率）</div>
          <div class="data-value ${grade.color}">${pe.toFixed(1)}倍</div>
          <div class="data-sub">${grade.level}档</div>
        </div>
        <div class="data-item">
          <div class="data-label">VIX恐慌指数</div>
          <div class="data-value ${data.vix > 25 ? 'orange' : data.vix > 20 ? 'yellow' : 'green'}">${data.vix?.toFixed(1) || '--'}</div>
          <div class="data-sub">${data.vix > 30 ? '高恐慌' : data.vix > 20 ? '偏高' : '正常'}</div>
        </div>
        <div class="data-item">
          <div class="data-label">10Y美债收益率</div>
          <div class="data-value">${data.treasury10y?.toFixed(2) || '--'}%</div>
          <div class="data-sub">股债比: ${data.equityBondRatio}</div>
        </div>
        <div class="data-item">
          <div class="data-label">距周四定投</div>
          <div class="data-value">${data.daysToThursday}天</div>
          <div class="data-sub">${data.isThursday ? '今天就是周四！' : data.isTradingDay ? '交易日' : '非交易日'}</div>
        </div>
        <div class="data-item">
          <div class="data-label">20日均线</div>
          <div class="data-value">${data.ndx.ma20?.toFixed(0) || '--'}</div>
          <div class="data-sub ${data.ndx.ma20Direction === 'up' ? 'green' : 'red'}">${data.ndx.ma20Direction === 'up' ? '↗ 向上' : '↘ 向下'}</div>
        </div>
      </div>

      <!-- PE仪表盘 -->
      <div class="pe-gauge">
        <div class="pe-gauge-fill" style="width:${pePercent}%;background:${gaugeColor}"></div>
        <div class="pe-gauge-marker" style="left:${pePercent}%"></div>
      </div>
      <div class="pe-gauge-labels">
        <span>15</span><span>25</span><span>28</span><span>32</span><span>35</span><span>40</span><span>50</span>
      </div>
    </div>

    <!-- 操作指令 -->
    <div class="card action-card ${grade.class}">
      <div class="card-title"><span class="emoji">⚡</span>操作指令</div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-size:13px;">✅ 周四定投</span>
        <span class="${grade.color}" style="font-weight:700;font-size:15px;">${grade.amount}元</span>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
        PE=${pe.toFixed(1)} → ${grade.level}档
      </div>

      <div style="border-top:1px solid var(--border);padding-top:10px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-size:13px;">✅ 额外加仓</span>
          <span style="font-weight:700;font-size:15px;" class="${addResult.shouldAdd ? 'green' : 'muted'}">
            ${addResult.shouldAdd ? `加仓${addResult.amount}元` : '不加仓'}
          </span>
        </div>
        ${addResult.reason ? `<div class="action-reason">${addResult.reason}</div>` : ''}
        ${eventDowngrade ? `<div style="font-size:11px;color:var(--accent-yellow);margin-top:4px;">⚠️ 事件降档已触发</div>` : ''}
      </div>

      <div style="border-top:1px solid var(--border);padding-top:10px;margin-top:10px;">
        <div style="display:flex;justify-content:space-between;font-size:13px;">
          <span>📊 今日总操作金额</span>
          <span class="${grade.color}" style="font-weight:800;font-size:18px;">
            ${grade.amount + (addResult.shouldAdd ? addResult.amount : 0)}元
          </span>
        </div>
      </div>
    </div>

    <!-- 事件日历 -->
    <div class="card">
      <div class="card-title"><span class="emoji">📅</span>事件日历</div>
      ${eventsHTML}
    </div>

    <!-- 趋势判断 -->
    <div class="card">
      <div class="card-title"><span class="emoji">📈</span>趋势判断</div>
      <div class="trend-indicator">
        <span class="trend-arrow">${trend.trendEmoji}</span>
        <div>
          <div class="trend-text">纳指处于 <span class="${data.ndx.ma20Direction === 'up' ? 'green' : 'red'}">${trend.trend}</span> 趋势</div>
          <div class="trend-detail">20日均线${data.ndx.ma20Direction === 'up' ? '↗向上' : '↘向下'}，从高点回撤${data.ndx.drawdown.toFixed(1)}%</div>
        </div>
      </div>
      <div style="font-size:12px;color:var(--text-secondary);margin-top:10px;line-height:1.6;">
        ${trend.advice}
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:8px;line-height:1.6;">
        若PE下行至28→恢复1000元正常档；若PE突破35→降至300元最低档。
      </div>
    </div>

    <!-- 数据说服 -->
    <div class="card quote-card">
      <div class="card-title" style="justify-content:center"><span class="emoji">📊</span>数据说服</div>
      <div class="quote-text">
        你当前累计投入约${userSettings.totalInvested > 0 ? (userSettings.totalInvested / 10000).toFixed(1) + '万' : '请设置'}元，
        ${userSettings.avgCost > 0 ? '持仓成本约' + userSettings.avgCost.toFixed(4) + '。' : ''}
        历史上PE从${persuasion.startPE}倍开始定投，持有12个月正收益概率约${persuasion.prob12m}。
        最可能情景下最大浮亏约${persuasion.maxLoss > 0 ? (persuasion.maxLoss / 10000).toFixed(1) + '万' : '--'}元（占总资产${persuasion.lossRatio}%）。
      </div>
      <div class="quote-text" style="font-size:14px;margin-top:8px;">
        市场恐惧时坚持买入，是定投策略超额收益的来源。<br>
        <strong>执行它，关掉软件。</strong>
      </div>
    </div>
  `;
}

function renderShortTermTab(data) {
  const tab = document.getElementById('tab-short');
  const addResult = calculateAdditionalBuy(data);
  const trend = analyzeTrend(data);
  const events = getUpcomingEvents(5);

  // 近5日价格走势
  const recentPrices = data.ndx.recentCloses.slice(-5);
  const priceChange5d = recentPrices.length >= 2
    ? ((recentPrices[recentPrices.length - 1] - recentPrices[0]) / recentPrices[0] * 100)
    : 0;

  // VIX趋势
  const vixTrend = data.vixRecent.length >= 3
    ? (data.vixRecent[data.vixRecent.length - 1] > data.vixRecent[0] ? '上升' : '下降')
    : '稳定';

  tab.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="emoji">🔍</span>短期分析（1-5日）</div>
      <div class="data-grid">
        <div class="data-item">
          <div class="data-label">近5日涨跌</div>
          <div class="data-value ${priceChange5d >= 0 ? 'green' : 'red'}">${priceChange5d >= 0 ? '+' : ''}${priceChange5d.toFixed(2)}%</div>
        </div>
        <div class="data-item">
          <div class="data-label">VIX趋势</div>
          <div class="data-value ${vixTrend === '上升' ? 'orange' : 'green'}">${vixTrend}</div>
          <div class="data-sub">当前${data.vix?.toFixed(1)}</div>
        </div>
        <div class="data-item">
          <div class="data-label">距20日均线</div>
          <div class="data-value ${data.ndx.price > data.ndx.ma20 ? 'green' : 'red'}">
            ${((data.ndx.price - data.ndx.ma20) / data.ndx.ma20 * 100).toFixed(1)}%
          </div>
        </div>
        <div class="data-item">
          <div class="data-label">从高点回撤</div>
          <div class="data-value ${data.ndx.drawdown > 10 ? 'red' : data.ndx.drawdown > 5 ? 'yellow' : 'green'}">
            ${data.ndx.drawdown.toFixed(1)}%
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title"><span class="emoji">⚡</span>短期操作建议</div>
      <div style="font-size:14px;line-height:1.8;color:var(--text-secondary)">
        ${generateShortTermAdvice(data, addResult, trend)}
      </div>
    </div>

    <div class="card">
      <div class="card-title"><span class="emoji">📅</span>近期事件影响</div>
      ${events.map(e => {
        const dateObj = new Date(e.date + 'T12:00:00');
        return `
          <div class="event-item">
            <span class="event-date">${dateObj.getMonth() + 1}/${dateObj.getDate()}</span>
            <div style="flex:1">
              <div class="event-name">${e.name}</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
                ${e.level === '一级' ? '⚠️ 可能触发事件降档' : '常规数据发布'}
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>

    <div class="card quote-card">
      <div class="quote-text">
        ${data.ndx.drawdown > 10
          ? '📉 短期回调较大，但定投策略不怕下跌。下跌正是收集廉价份额的时机。保持纪律，按规则执行。'
          : data.ndx.change > 2
            ? '📈 短期涨幅较大，不追高。按正常档位定投即可，额外加仓条件未满足。'
            : '↔️ 短期市场平稳运行，坚持每周定投纪律。不因涨跌情绪化操作。'
        }
      </div>
    </div>
  `;
}

function renderMidTermTab(data) {
  const tab = document.getElementById('tab-mid');

  // 近30日数据
  const closes = data.ndx.recentCloses;
  const high30 = Math.max(...closes);
  const low30 = Math.min(...closes);
  const current = data.ndx.price;
  const midChange = closes.length >= 2
    ? ((current - closes[0]) / closes[0] * 100)
    : 0;

  // 波动率（近30日）
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const volatility = Math.sqrt(returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / returns.length) * Math.sqrt(252) * 100;

  // PE趋势
  const peHistory = data.historicalPE;
  const avgPE = peHistory.reduce((a, b) => a + b, 0) / peHistory.length;
  const peTrend = peHistory.length >= 10
    ? (peHistory[peHistory.length - 1] > peHistory[peHistory.length - 10] ? '上行' : '下行')
    : '稳定';

  tab.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="emoji">📊</span>中期复盘（1-3个月）</div>
      <div class="data-grid">
        <div class="data-item">
          <div class="data-label">30日涨跌幅</div>
          <div class="data-value ${midChange >= 0 ? 'green' : 'red'}">${midChange >= 0 ? '+' : ''}${midChange.toFixed(2)}%</div>
        </div>
        <div class="data-item">
          <div class="data-label">30日最高/最低</div>
          <div class="data-value small">${high30.toFixed(0)} / ${low30.toFixed(0)}</div>
        </div>
        <div class="data-item">
          <div class="data-label">年化波动率</div>
          <div class="data-value ${volatility > 25 ? 'orange' : 'green'}">${volatility.toFixed(1)}%</div>
          <div class="data-sub">${volatility > 25 ? '高波动' : '正常波动'}</div>
        </div>
        <div class="data-item">
          <div class="data-label">PE趋势</div>
          <div class="data-value ${peTrend === '下行' ? 'green' : peTrend === '上行' ? 'orange' : 'blue'}">${peTrend}</div>
          <div class="data-sub">均值${avgPE.toFixed(1)}倍</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title"><span class="emoji">💡</span>中期操作建议</div>
      <div style="font-size:14px;line-height:1.8;color:var(--text-secondary)">
        ${generateMidTermAdvice(data, volatility, peTrend)}
      </div>
    </div>

    <div class="card">
      <div class="card-title"><span class="emoji">📐</span>定投成本分析</div>
      <div style="font-size:14px;line-height:1.8;color:var(--text-secondary)">
        ${userSettings.totalInvested > 0 ? `
          <div class="data-grid">
            <div class="data-item">
              <div class="data-label">累计投入</div>
              <div class="data-value">${(userSettings.totalInvested / 10000).toFixed(2)}万</div>
            </div>
            <div class="data-item">
              <div class="data-label">当前市值</div>
              <div class="data-value ${userSettings.currentValue >= userSettings.totalInvested ? 'green' : 'red'}">
                ${(userSettings.currentValue / 10000).toFixed(2)}万
              </div>
            </div>
            <div class="data-item full">
              <div class="data-label">累计盈亏</div>
              <div class="data-value ${userSettings.currentValue - userSettings.totalInvested >= 0 ? 'green' : 'red'}">
                ${((userSettings.currentValue - userSettings.totalInvested) / 10000).toFixed(2)}万
                (${((userSettings.currentValue - userSettings.totalInvested) / userSettings.totalInvested * 100).toFixed(1)}%)
              </div>
            </div>
          </div>
        ` : '请先在设置中填写你的定投数据，以便进行成本分析。'}
      </div>
    </div>
  `;
}

function renderLongTermTab(data) {
  const tab = document.getElementById('tab-long');
  const pe = data.pe;
  const persuasion = generateDataPersuasion(data);

  // 长期PE百分位（模拟）
  const pePercentile = calculatePEPercentile(pe);

  tab.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="emoji">🌐</span>长期趋势（1年+）</div>
      <div class="data-grid">
        <div class="data-item">
          <div class="data-label">当前PE</div>
          <div class="data-value ${data.peGrade.color}">${pe.toFixed(1)}倍</div>
        </div>
        <div class="data-item">
          <div class="data-label">PE历史百分位</div>
          <div class="data-value ${pePercentile < 30 ? 'green' : pePercentile > 70 ? 'red' : 'blue'}">${pePercentile.toFixed(0)}%</div>
          <div class="data-sub">${pePercentile < 30 ? '低估区间' : pePercentile > 70 ? '高估区间' : '合理区间'}</div>
        </div>
        <div class="data-item">
          <div class="data-label">12月正收益概率</div>
          <div class="data-value green">${persuasion.prob12m}</div>
        </div>
        <div class="data-item">
          <div class="data-label">预估最大浮亏</div>
          <div class="data-value orange">${persuasion.maxDrawdownPct}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title"><span class="emoji">🎯</span>长期策略建议</div>
      <div style="font-size:14px;line-height:1.8;color:var(--text-secondary)">
        ${generateLongTermAdvice(data, pePercentile)}
      </div>
    </div>

    <div class="card">
      <div class="card-title"><span class="emoji">📜</span>定投铁律回顾</div>
      <div style="font-size:13px;line-height:2;color:var(--text-secondary)">
        <div>1️⃣ 周四定投基准1000元，按PE档位自动调整</div>
        <div>2️⃣ 加仓仅限周一/二/三/五，单日封顶1000元</div>
        <div>3️⃣ PE<25加倍 | 25-28为1.5倍 | 28-32正常 | 32-35半额 | 35-40最低 | >40暂停</div>
        <div>4️⃣ 跌2-4%加仓500元 | 跌≥4%加仓1000元 | 跌≥7%极端超跌</div>
        <div>5️⃣ 一级事件前1日、VIX>30+周跌>5%、年末季末 → 降一档</div>
        <div>6️⃣ 每周定投占总资产仅${persuasion.weeklyRatio}%，执行它，关掉软件</div>
      </div>
    </div>

    <div class="card quote-card">
      <div class="quote-text">
        定投的本质是用时间换空间，用纪律战胜人性。<br>
        纳指长期年化收益约10-15%，短期波动是收集廉价份额的机会。<br>
        <strong>坚持3年以上，大概率跑赢任何主动管理策略。</strong>
      </div>
    </div>
  `;
}

function renderHistoryTab() {
  const tab = document.getElementById('tab-history');
  const history = getInvestHistory();

  if (history.length === 0) {
    tab.innerHTML = `
      <div class="card">
        <div class="card-title"><span class="emoji">📝</span>定投记录</div>
        <div style="text-align:center;padding:40px 0;color:var(--text-muted);">
          <div style="font-size:48px;margin-bottom:12px;">📋</div>
          <div>暂无定投记录</div>
          <div style="font-size:12px;margin-top:8px;">记录将自动保存在本地</div>
        </div>
      </div>
    `;
    return;
  }

  const totalInvested = history.reduce((sum, h) => sum + h.amount, 0);

  tab.innerHTML = `
    <div class="card">
      <div class="card-title"><span class="emoji">📝</span>定投记录</div>
      <div class="data-grid" style="margin-bottom:12px;">
        <div class="data-item">
          <div class="data-label">累计投入</div>
          <div class="data-value">${(totalInvested / 10000).toFixed(2)}万</div>
        </div>
        <div class="data-item">
          <div class="data-label">操作次数</div>
          <div class="data-value">${history.length}次</div>
        </div>
      </div>
      ${history.slice().reverse().map(h => `
        <div class="history-item">
          <span class="history-date">${h.date}</span>
          <span class="history-action">${h.type}</span>
          <span class="history-amount ${h.amount > 0 ? 'green' : 'muted'}">${h.amount > 0 ? '+' : ''}${h.amount}元</span>
        </div>
      `).join('')}
    </div>
    <div style="text-align:center;margin-top:8px;">
      <button onclick="clearHistory()" style="padding:8px 16px;background:rgba(239,68,68,0.15);color:var(--accent-red);border:1px solid rgba(239,68,68,0.3);border-radius:8px;font-size:12px;cursor:pointer;">清空记录</button>
    </div>
  `;
}

// ===== 建议生成函数 =====

function generateShortTermAdvice(data, addResult, trend) {
  const parts = [];

  // 今日操作
  if (data.isThursday) {
    parts.push(`<strong class="${data.peGrade.color}">今天是定投日，执行${data.peGrade.amount}元定投。</strong>`);
  } else if (data.isTradingDay) {
    if (addResult.shouldAdd) {
      parts.push(`<strong class="green">今日可加仓${addResult.amount}元。</strong>原因：${addResult.step1}`);
    } else {
      parts.push(`<strong class="muted">今日不加仓。</strong>${addResult.reason || ''}`);
    }
  } else {
    parts.push('今日非交易日，无需操作。');
  }

  // 短期趋势
  if (data.ndx.drawdown > 10) {
    parts.push('短期回撤较大，关注PE档位变化。若PE降至28以下，恢复正常档位定投。');
  } else if (data.ndx.change > 3) {
    parts.push('短期涨幅较大，注意不要追高。按规则只在跌幅触发时加仓。');
  } else {
    parts.push('短期波动正常，坚持既定定投纪律。');
  }

  // VIX提醒
  if (data.vix > 25) {
    parts.push(`VIX=${data.vix.toFixed(1)}偏高，市场波动加剧。保持纪律，不因恐慌暂停定投。`);
  }

  return parts.join('<br><br>');
}

function generateMidTermAdvice(data, volatility, peTrend) {
  const parts = [];

  // 波动率分析
  if (volatility > 30) {
    parts.push('中期波动率较高，市场不确定性增加。这是定投策略发挥优势的环境——波动越大，收集筹码的成本越平均。');
  } else if (volatility < 15) {
    parts.push('中期波动率较低，市场运行平稳。坚持定投，为下一轮波动积累筹码。');
  } else {
    parts.push('中期波动率处于正常范围，定投策略稳步推进。');
  }

  // PE趋势
  if (peTrend === '下行') {
    parts.push('PE呈下行趋势，意味着同样金额可以买到更多份额。这是定投的黄金时期，不要因为浮亏而停止。');
  } else if (peTrend === '上行') {
    parts.push('PE呈上行趋势，估值在抬高。按规则降低档位，控制投入节奏。');
  }

  // 中期建议
  if (data.pe > 35) {
    parts.push('当前PE偏高，中期建议维持最低档定投（300元），不额外加仓。等待估值回归后再加大投入。');
  } else if (data.pe < 25) {
    parts.push('当前PE处于低估区间，中期建议加倍定投（2000元），积极收集廉价份额。这是超额收益的来源。');
  } else {
    parts.push('当前PE处于合理区间，中期建议按正常档位（1000元）定投，保持节奏。');
  }

  return parts.join('<br><br>');
}

function generateLongTermAdvice(data, pePercentile) {
  const parts = [];

  // 百分位分析
  if (pePercentile < 20) {
    parts.push('当前PE处于历史低位（<20%分位），长期来看是极佳的定投窗口。历史上从这一水平开始定投，3年正收益概率超过90%。建议积极投入。');
  } else if (pePercentile < 50) {
    parts.push('当前PE处于历史中低位（<50%分位），长期定投胜率较高。保持纪律，坚持每周定投。');
  } else if (pePercentile < 80) {
    parts.push('当前PE处于历史中高位（50-80%分位），定投仍可继续但需控制节奏。按规则执行，不随意加码。');
  } else {
    parts.push('当前PE处于历史高位（>80%分位），需警惕估值回归风险。维持最低档定投，不追高。耐心等待回调机会。');
  }

  // 长期视角
  parts.push('纳指代表美国科技核心资产，长期年化收益约10-15%。定投策略的核心优势在于"低买高平均"，通过纪律性买入平滑成本。');
  parts.push('建议至少坚持3年以上。历史数据显示，持有纳指3年以上正收益概率超过85%。短期浮亏是长期收益的代价。');

  return parts.join('<br><br>');
}

// ===== PE百分位计算（模拟）=====
function calculatePEPercentile(currentPE) {
  // 基于纳指历史PE分布的近似计算
  // 纳指PE历史范围约15-50，中位数约25-28
  const mean = 27;
  const std = 6;
  // 使用正态分布近似
  const z = (currentPE - mean) / std;
  // 近似累积分布函数
  const percentile = 0.5 * (1 + erf(z / Math.sqrt(2)));
  return percentile * 100;
}

function erf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

// ===== 工具函数 =====

function getNYTime() {
  const now = new Date();
  // 转换为美东时间
  const nyTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return nyTime;
}

function formatDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}`;
}

function getDayName(day) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][day];
}

// ===== Tab切换 =====

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

  event.target.classList.add('active');
  document.getElementById(`tab-${tabName}`).classList.add('active');
}

// ===== 刷新数据 =====

async function refreshData() {
  const loading = document.getElementById('loadingState');
  const error = document.getElementById('errorState');
  const refreshBtn = document.getElementById('refreshBtn');

  // 显示加载状态
  loading.style.display = 'flex';
  error.style.display = 'none';
  refreshBtn.classList.add('spinning');

  try {
    const data = await fetchAllMarketData();
    marketData = data;

    // 隐藏加载
    loading.style.display = 'none';

    // 渲染
    renderAllTabs(data);
    updateHeaderStatus(data);

    // 记录今日定投
    if (!data._mock && !data._stale) {
      recordTodayInvest(data);
    }

  } catch (err) {
    console.error('Data fetch error:', err);
    loading.style.display = 'none';

    // 如果有缓存数据，即使刷新失败也显示缓存
    if (marketData) {
      renderAllTabs(marketData);
      updateHeaderStatus({...marketData, _stale: true});
    } else {
      error.style.display = 'block';
      document.getElementById('errorMsg').textContent = `数据加载失败: ${err.message}`;
      const statusBadge = document.getElementById('statusBadge');
      const statusText = document.getElementById('statusText');
      statusBadge.className = 'status-badge error';
      statusText.textContent = '离线';
    }
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

// ===== 设置管理 =====

function loadSettings() {
  try {
    const saved = localStorage.getItem('nasdaq_dca_settings');
    if (saved) {
      const parsed = JSON.parse(saved);
      userSettings = { ...userSettings, ...parsed };
    }
  } catch (e) {
    console.warn('Settings load failed:', e);
  }

  // 填充设置表单
  document.getElementById('setTotalInvested').value = userSettings.totalInvested || '';
  document.getElementById('setAvgCost').value = userSettings.avgCost || '';
  document.getElementById('setCurrentValue').value = userSettings.currentValue || '';
  document.getElementById('setStartDate').value = userSettings.startDate || '';
  document.getElementById('setTotalAssets').value = userSettings.totalAssets || 650000;
}

function saveSettings() {
  userSettings.totalInvested = parseFloat(document.getElementById('setTotalInvested').value) || 0;
  userSettings.avgCost = parseFloat(document.getElementById('setAvgCost').value) || 0;
  userSettings.currentValue = parseFloat(document.getElementById('setCurrentValue').value) || 0;
  userSettings.startDate = document.getElementById('setStartDate').value;
  userSettings.totalAssets = parseFloat(document.getElementById('setTotalAssets').value) || 650000;

  localStorage.setItem('nasdaq_dca_settings', JSON.stringify(userSettings));
  closeSettings();

  // 重新渲染
  if (marketData) {
    renderTodayTab(marketData);
    renderShortTermTab(marketData);
    renderMidTermTab(marketData);
    renderLongTermTab(marketData);
  }
}

function toggleSettings() {
  document.getElementById('settingsOverlay').classList.add('show');
}

function closeSettings(e) {
  if (!e || e.target === document.getElementById('settingsOverlay')) {
    document.getElementById('settingsOverlay').classList.remove('show');
  }
}

// ===== 定投记录 =====

function getInvestHistory() {
  try {
    const saved = localStorage.getItem('nasdaq_dca_history');
    return saved ? JSON.parse(saved) : [];
  } catch (e) {
    return [];
  }
}

function recordTodayInvest(data) {
  const history = getInvestHistory();
  const today = formatDateStr(new Date());

  // 检查今天是否已记录
  if (history.find(h => h.date === today)) return;

  const grade = data.peGrade;
  const addResult = calculateAdditionalBuy(data);

  const records = [];

  // 周四定投记录
  if (data.isThursday && grade.amount > 0) {
    records.push({
      date: today,
      type: '周四定投',
      amount: grade.amount,
      pe: data.pe,
      ndx: data.ndx.price,
    });
  }

  // 加仓记录
  if (addResult.shouldAdd && addResult.amount > 0) {
    records.push({
      date: today,
      type: '额外加仓',
      amount: addResult.amount,
      pe: data.pe,
      ndx: data.ndx.price,
    });
  }

  if (records.length > 0) {
    history.push(...records);
    localStorage.setItem('nasdaq_dca_history', JSON.stringify(history));
  }
}

function clearHistory() {
  if (confirm('确定要清空所有定投记录吗？')) {
    localStorage.removeItem('nasdaq_dca_history');
    renderHistoryTab();
  }
}

// ===== 数据缓存 =====

function saveCachedData(data) {
  try {
    localStorage.setItem('nasdaq_dca_cache', JSON.stringify({
      timestamp: data.timestamp,
      data: data,
    }));
  } catch (e) {
    console.warn('Cache save failed:', e);
  }
}

function loadCachedData() {
  try {
    const saved = localStorage.getItem('nasdaq_dca_cache');
    if (saved) {
      const parsed = JSON.parse(saved);
      return parsed.data;
    }
  } catch (e) {
    console.warn('Cache load failed:', e);
  }
  return null;
}

// ===== 模拟数据生成 =====

function generateMockData() {
  const today = getNYTime();
  const dayOfWeek = today.getDay();
  const isTradingDay = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isThursday = dayOfWeek === 4;

  // 模拟价格（基于近期纳指大致水平）
  const basePrice = 21000;
  const priceVariation = (Math.random() - 0.5) * 400;
  const currentPrice = basePrice + priceVariation;
  const prevClose = currentPrice - (Math.random() - 0.5) * 200;
  const dailyChange = ((currentPrice - prevClose) / prevClose * 100);

  // 生成模拟历史收盘价
  const recentCloses = [];
  for (let i = 30; i >= 0; i--) {
    recentCloses.push(currentPrice - i * (Math.random() * 50 + 10) + (Math.random() - 0.5) * 300);
  }

  const ma20 = recentCloses.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const high60d = Math.max(...recentCloses);
  const drawdown = ((high60d - currentPrice) / high60d * 100);

  const weekAgoPrice = recentCloses[recentCloses.length - 6] || currentPrice;
  const weeklyChange = ((currentPrice - weekAgoPrice) / weekAgoPrice * 100);

  // 模拟PE
  const pe = estimatePE(currentPrice);

  // 模拟VIX
  const vix = 15 + Math.random() * 15;

  // 模拟美债收益率
  const treasury10y = 4.0 + Math.random() * 1.0;

  // 距周四
  let daysToThursday = (4 - dayOfWeek + 7) % 7;
  if (daysToThursday === 0 && isTradingDay) daysToThursday = 0;
  else if (daysToThursday === 0) daysToThursday = 7;

  // 股债性价比
  const equityBondRatio = (1.5 / treasury10y).toFixed(2);

  // 历史PE
  const historicalPE = recentCloses.map(c => estimatePE(c));

  const data = {
    timestamp: Date.now(),
    nyTime: today,
    _mock: true,

    ndx: {
      price: currentPrice,
      prevClose: prevClose,
      change: dailyChange,
      weeklyChange: weeklyChange,
      high60d: high60d,
      drawdown: drawdown,
      ma20: ma20,
      ma20Direction: currentPrice > ma20 ? 'up' : 'down',
      recentCloses: recentCloses,
      timestamps: [],
    },

    pe: pe,
    peGrade: getPEGrade(pe),

    vix: vix,
    vixRecent: [vix - 1, vix + 0.5, vix - 0.3, vix + 1, vix],

    treasury10y: treasury10y,
    equityBondRatio: equityBondRatio,

    isTradingDay: isTradingDay,
    isThursday: isThursday,
    daysToThursday: daysToThursday,
    dayOfWeek: dayOfWeek,

    historicalPE: historicalPE,
  };

  marketData = data;
  lastFetchTime = Date.now();
  return data;
}
