const sdk = require('@defillama/sdk');
const superagent = require('superagent');
const abi = require("./abis.json");

const unitroller = '0xfD36E2c2a6789Db23113685031d7F16329158384';
const VBNB = '0xA07c5b74C9B40447a954e1466938b865b6BBea36';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const BETH = '0x250632378e573c6be1ac2f97fcdf00515d0aa91b';
const XVS = '0xcf6bb5389c92bdda8a3747ddb454cb7a64626c63';


const poolInfo = async (chain) => {
    const getAllMarkets = await sdk.api.abi.call({ target: unitroller, chain, abi: abi.getAllMarkets });

    // filter out unsupported vcan pool
    const yieldMarkets = getAllMarkets.output.map((pool) => {
        return { pool }
    }).filter((pool) => pool.pool.toLowerCase() !== '0xebd0070237a0713e8d94fef1b728d3d993d290ef');

    const getOutput = ({ output }) => output.map(({ output }) => output);
    const [markets, venusSpeeds] = await Promise.all(
        ['markets', 'venusSpeeds'].map((method) => sdk.api.abi.multiCall({
            abi: abi[method],
            target: unitroller,
            calls: yieldMarkets.map((pool) => ({
                params: pool.pool
            })),
            chain
        }))
    ).then((data) => data.map(getOutput));
    const collateralFactor = markets.map((data) => data.collateralFactorMantissa);

    const [borrowRatePerBlock, supplyRatePerBlock, getCash, totalBorrows, totalReserves, underlyingToken, tokenSymbol] = await Promise.all(
        ['borrowRatePerBlock', 'supplyRatePerBlock', 'getCash', 'totalBorrows', 'totalReserves', 'underlying', 'symbol'].map((method) => sdk.api.abi.multiCall({
            abi: abi[method],
            calls: yieldMarkets.map((pool) => ({
                target: pool.pool
            })),
            chain
        }))
    ).then((data) => data.map(getOutput));

    // no underlying token in vbnb swap null -> wbnb
    underlyingToken.find((token, index, arr) => { if (token === null) arr[index] = WBNB });

    const underlyingTokenDecimals = (await sdk.api.abi.multiCall({
        abi: abi.decimals,
        calls: underlyingToken.map(token => ({
            target: token
        })),
        chain
    })).output.map((decimal) => Math.pow(10, Number(decimal.output)));

    //incorrect beth price swap beth 0xaddress -> coingecko id
    const price = await getPricesConditionalId(chain, underlyingToken, BETH, 'binance-eth');

    yieldMarkets.map((data, index) => {
        data.collateralFactor = collateralFactor[index];
        data.venusSpeeds = venusSpeeds[index];
        data.borrowRatePerBlock = borrowRatePerBlock[index];
        data.supplyRatePerBlock = supplyRatePerBlock[index];
        data.getCash = getCash[index];
        data.totalBorrows = totalBorrows[index];
        data.totalReserves = totalReserves[index];
        data.underlyingToken = underlyingToken[index];
        data.tokenSymbol = tokenSymbol[index];
        data.price = price.priceList[price.addressList[index].toLowerCase()];
        data.underlyingTokenDecimals = underlyingTokenDecimals[index];
        data.rewardTokens = [XVS];
    });
    console.log(yieldMarkets);
    return { yieldMarkets };
}

const getPricesConditionalId = async (chain, addresses, condition, id) => {
    const chainList = [];
    const addressList = [];
    addresses.map((token, index) => {
        if (token.toLowerCase() === condition.toLowerCase()) {
            chainList.push('coingecko');
            addressList[index] = id;
        } else {
            chainList.push(chain);
            addressList[index] = token;
        }
    });

    const priceList = await getPrices(chainList, addressList);

    return { priceList, addressList };
}

const getPrices = async (chain, addresses) => {
    const prices = (
        await superagent.post('https://coins.llama.fi/prices').send({
            coins: addresses.map((address, index) => `${chain[index]}:${address}`),
        })
    ).body.coins;

    const pricesObj = Object.entries(prices).reduce(
        (acc, [address, price]) => ({
            ...acc,
            [address.split(':')[1].toLowerCase()]: price.price,
        }),
        {}
    );

    return pricesObj;
}

function calculateApy(rate, price = 1, tvl = 1) {
    // supply rate per block * number of blocks per year
    const BLOCK_TIME = 3;
    const YEARLY_BLOCKS = 365 * 24 * 60 * 60 / BLOCK_TIME;
    const apy = ((rate / 1e18) * YEARLY_BLOCKS * price / tvl) * 100;
    return apy;
}

function calculateTvl(cash, borrows, reserves, price, decimals) {
    // ( cash + totalBorrows - reserve value ) * underlying price = balance
    const tvl = ((parseFloat(cash) + parseFloat(borrows) - parseFloat(reserves)) / decimals) * price;
    return tvl;
}

const getApy = async () => {
    const priceOf = await getPrices(['bsc'], [XVS]);
    const yieldPools = (await poolInfo('bsc')).yieldMarkets.map((pool, i) => {
        const totalSupplyUsd = calculateTvl(pool.getCash, pool.totalBorrows, pool.totalReserves, pool.price, pool.underlyingTokenDecimals);
        const totalBorrowUsd = calculateTvl(0, pool.totalBorrows, 0, pool.price, pool.underlyingTokenDecimals);
        const tvl = totalSupplyUsd - totalBorrowUsd;
        const apyBase = calculateApy(pool.supplyRatePerBlock);
        const apyReward = calculateApy(pool.venusSpeeds, priceOf[XVS], totalSupplyUsd);
        const apyBaseBorrow = calculateApy(pool.borrowRatePerBlock);
        const apyRewardBorrow = calculateApy(pool.venusSpeeds, priceOf[XVS], totalBorrowUsd);
        const ltv = parseInt(pool.collateralFactor) / 1e18;
        const readyToExport = exportFormatter(pool.pool, 'Binance', pool.tokenSymbol, tvl, apyBase, apyReward,
            pool.underlyingToken, pool.rewardTokens, apyBaseBorrow, apyRewardBorrow, totalSupplyUsd, totalBorrowUsd, ltv);

        return readyToExport;
    });
    console.log(yieldPools);
    return yieldPools;
}

function exportFormatter(pool, chain, symbol, tvlUsd, apyBase, apyReward,
    underlyingTokens, rewardTokens, apyBaseBorrow, apyRewardBorrow, totalSupplyUsd, totalBorrowUsd, ltv) {

    return {
        pool: pool.toLowerCase(),
        chain,
        project: 'venus',
        symbol,
        tvlUsd,
        apyBase,
        apyReward,
        underlyingTokens: [underlyingTokens],
        rewardTokens,
        apyBaseBorrow,
        apyRewardBorrow,
        totalSupplyUsd,
        totalBorrowUsd,
        ltv,
    };
}


module.exports = {
    timetravel: false,
    apy: getApy,
    url: 'https://app.venus.io/markets',
};