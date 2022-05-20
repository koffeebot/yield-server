const utils = require('../utils');

const poolsFunction = async () => {
  const vaultData = await utils.getData('https://api.robo-vault.com/vaults');
  const poolData = vaultData.filter(e => e.status.toLowerCase() === 'active');

  return poolData.map(item => ({
      pool: item.addr,
      chain: utils.formatChain(item.chain),
      project: 'robo-vault',
      symbol: utils.formatSymbol(item.symbol),
      tvlUsd: item.tvlUsd,
      apy: item.apy3d * 100,
    })
  );
};

module.exports = {
  timetravel: false,
  apy: poolsFunction,
};