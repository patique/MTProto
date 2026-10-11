/**
 * Especificaciones conservadoras por activo para convertir distancia de SL
 * en riesgo monetario. Ajustar aqui si el broker usa otro contrato.
 */

const SYMBOL_SPECS = [
  {
    match: ['XAU', 'GOLD'],
    pipSize: 0.1,
    pipValuePerLot: 10,
    propFirmMaxLotsPerBalanceUSD: 1 / 50000
  },
  {
    match: ['EURUSD'],
    pipSize: 0.0001,
    pipValuePerLot: 10
  },
  {
    match: ['GBPJPY'],
    pipSize: 0.01,
    pipValuePerLot: 9
  },
  {
    match: ['GBPUSD'],
    pipSize: 0.0001,
    pipValuePerLot: 10
  },
  {
    match: ['USDCAD'],
    pipSize: 0.0001,
    pipValuePerLot: 7.5
  },
  {
    match: ['AUDUSD'],
    pipSize: 0.0001,
    pipValuePerLot: 10
  },
  {
    match: ['USDJPY'],
    pipSize: 0.01,
    pipValuePerLot: 6.8
  },
  {
    match: ['NAS100', 'US100', 'USTEC', 'NDX'],
    pipSize: 1,
    pipValuePerLot: 1
  }
];

function normalizeSymbol(symbol = '') {
  return String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function getSymbolSpec(symbol = '') {
  const normalized = normalizeSymbol(symbol);
  return SYMBOL_SPECS.find(spec => spec.match.some(token => normalized.includes(token))) || {
    match: ['DEFAULT_FOREX'],
    pipSize: 0.0001,
    pipValuePerLot: 10
  };
}

module.exports = {
  SYMBOL_SPECS,
  getSymbolSpec,
  normalizeSymbol
};
