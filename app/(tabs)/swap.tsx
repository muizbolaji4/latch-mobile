import { Swap as SwapIcon } from '@/src/components/CustomTabBar';
import Box from '@/src/components/shared/Box';
import Text from '@/src/components/shared/Text';
import SwapCard from '@/src/components/swap/SwapCard';
import SwapRoutePickerSheet from '@/src/components/swap/SwapRoutePickerSheet';
import SwapTokenPickerSheet from '@/src/components/swap/SwapTokenPickerSheet';
import { swapTokenImage } from '@/src/components/swap/token-image';
import { STELLAR_NETWORK_PASSPHRASE } from '@/src/constants/config';
import { getWellKnownTokens } from '@/src/constants/known-tokens';
import { usePortfolio } from '@/src/hooks/use-portfolio';
import { usePrices } from '@/src/hooks/use-prices';
import { ImplausibleQuoteError, useSwapQuote } from '@/src/hooks/use-swap-quote';
import { useTokenIcon, useTokenList } from '@/src/hooks/use-token-list';
import { useTrackedTokens } from '@/src/hooks/use-tracked-tokens';
import { useTabBarScroll } from '@/src/context/tab-bar-scroll';
import { getActiveSwapProvider, listSwapProviders } from '@/src/services/swap/registry';
import type { SwapToken } from '@/src/services/swap/types';
import { useWalletStore } from '@/src/store/wallet';
import { Theme } from '@/src/theme/theme';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@shopify/restyle';
import { Asset } from '@stellar/stellar-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFormik } from 'formik';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
} from 'react-native';
import Toast from 'react-native-toast-message';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Yup from 'yup';

const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%

const formatUsd = (amountStr: string, price?: string) => {
  const amount = parseFloat(amountStr || '0');
  const p = parseFloat(price ?? '0');
  if (!amount || !p) return '≈$0.00';
  return `≈$${(amount * p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const Swap = () => {
  const theme = useTheme<Theme>();
  const isDark = theme.colors.mainBackground === '#000000';
  const insets = useSafeAreaInsets();
  const tabBarScroll = useTabBarScroll();
  const queryClient = useQueryClient();
  const { smartAccountAddress, accounts, activeAccountIndex } = useWalletStore();
  const activeAccount = accounts[activeAccountIndex];
  const { tokens: trackedTokens } = useTrackedTokens();
  const { data: prices, refetch: refetchPrices } = usePrices();
  const { data: portfolio, refetch: refetchPortfolio } = usePortfolio(
    smartAccountAddress,
    activeAccount?.gAddress,
    trackedTokens,
  );
  // Mounted for its refetch only — useTokenIcon already reads this same
  // ['token-list'] query, so the extra observer shares the cached result.
  const { refetch: refetchTokenList } = useTokenList();

  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    // RefreshControl can fire again mid-flight (release, pull again); a second
    // pass would reset `refreshing` when the FIRST one finishes and leave the
    // spinner detached from the requests still running.
    if (refreshing) return;
    setRefreshing(true);
    try {
      // The swap quote is deliberately not refetched here. Re-pricing the leg
      // the user is reading, under their finger, is a different action from
      // refreshing what they hold — useFocusEffect already handles staleness on
      // re-entry.
      const results = await Promise.all([
        refetchPrices(),
        refetchPortfolio(),
        refetchTokenList(),
      ]);
      // refetch() resolves with the failure rather than rejecting, so a failed
      // pull is silent unless the results are inspected. React Query keeps the
      // last successful data on the query, so the screen still shows it.
      if (results.some((r) => r.isError)) {
        Toast.show({ type: 'error', text1: "Couldn't refresh balances" });
      }
    } finally {
      setRefreshing(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      queryClient.invalidateQueries({ queryKey: ['prices'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      // Cached quotes are priced at the moment they were fetched. Returning to
      // this screen must never re-render one as if it were current.
      queryClient.invalidateQueries({ queryKey: ['swap-quote'] });
    }, [queryClient]),
  );

  // Tokens the account actually HOLDS (non-zero balance). Used to seed the
  // From leg and to supply real balances; both pickers list the full
  // swappable universe so a quote can be fetched without holding the token.
  const tokens = useMemo(() => portfolio ?? [], [portfolio]);

  // fromToken/toToken hold a *snapshot* of the token object, so any balance read
  // off them is frozen at the moment of selection — and the initial selection
  // happens before usePortfolio resolves, when every candidate still carries the
  // `amount: '0'` placeholder from swappableTokens. Balances are therefore looked
  // up live by SAC id instead of read from the selection.
  const heldBySac = useMemo(
    () => new Map(tokens.map((t) => [t.sacContractId, t])),
    [tokens],
  );
  const balanceOf = useCallback(
    (token: SwapToken | null) =>
      token ? (heldBySac.get(token.sacContractId)?.amount ?? '0') : '0',
    [heldBySac],
  );

  // Full swappable universe for the "To" leg: well-known + tracked tokens (which
  // you may not hold yet), with held balances overlaid. usePortfolio drops
  // zero-balance tokens, so it alone can't populate the destination picker.
  const swappableTokens = useMemo<SwapToken[]>(() => {
    const map = new Map<string, SwapToken>();
    const addConfig = (code: string, issuer: string | undefined, sacContractId: string) => {
      if (!map.has(sacContractId)) {
        map.set(sacContractId, { code, issuer, sacContractId, amount: '0', usdValue: 0 });
      }
    };
    addConfig('XLM', undefined, Asset.native().contractId(STELLAR_NETWORK_PASSPHRASE));
    // for (const t of [...getWellKnownTokens(), ...trackedTokens]) {
    for (const t of getWellKnownTokens()) {
      try {
        const sac =
          t.sacContractId ?? new Asset(t.code, t.issuer!).contractId(STELLAR_NETWORK_PASSPHRASE);
        addConfig(t.code, t.issuer, sac);
      } catch {
        // skip tokens we can't resolve a SAC id for
      }
    }
    // Held balances override the zero-balance placeholders.
    for (const held of tokens) map.set(held.sacContractId, held);
    return Array.from(map.values());
  }, [
    // trackedTokens,
    tokens,
  ]);

  // undefined → use the network's default (first) provider. A stale id from a
  // previous network is harmless: getActiveSwapProvider falls back to the
  // default when the id isn't registered for the active network.
  const [selectedProviderId, setSelectedProviderId] = useState<string | undefined>(undefined);
  const provider = getActiveSwapProvider(selectedProviderId);
  const availableProviders = listSwapProviders();

  const [fromToken, setFromToken] = useState<SwapToken | null>(null);
  const [toToken, setToToken] = useState<SwapToken | null>(null);
  // True while From holds a pre-portfolio placeholder that may still be replaced
  // by a held token. Any deliberate act by the user clears it — a late re-seed
  // must never overwrite a choice they made themselves.
  const fromSeedProvisional = useRef(false);
  const [pickerSide, setPickerSide] = useState<'from' | 'to' | null>(null);
  const [showRoutePicker, setShowRoutePicker] = useState(false);
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [showSlippageOptions, setShowSlippageOptions] = useState(false);
  const [customSlippage, setCustomSlippage] = useState('');
  const [showUsdRate, setShowUsdRate] = useState(false);

  const applyCustomSlippage = (pct: string) => {
    setCustomSlippage(pct);
    const bps = Math.round(parseFloat(pct) * 100);
    if (Number.isFinite(bps) && bps > 0 && bps <= 5000) setSlippageBps(bps);
  };

  // Remote token icons from the Soroswap token list (same source as the picker)
  // so a selected token keeps its real logo instead of the local-asset fallback.
  const fromIconUrl = useTokenIcon(fromToken?.code, fromToken?.issuer);
  const toIconUrl = useTokenIcon(toToken?.code, toToken?.issuer);

  // Seed From from a held token when there is one, otherwise fall back to the
  // swappable universe. Quoting is a read-only price lookup, so an empty
  // portfolio must not leave From null — that would disable useSwapQuote and
  // hide the whole details block (route/rate/slippage) behind `quote &&`.
  // Approve stays correctly blocked by `insufficient` below.
  useEffect(() => {
    const holdingsLoaded = tokens.length > 0;
    const fromCandidates = holdingsLoaded ? tokens : swappableTokens;

    if (!fromToken && fromCandidates.length > 0) {
      // A seed taken before the portfolio resolves is a placeholder rather than
      // a choice — it comes from swappableTokens, where every entry reads
      // `amount: '0'`.
      fromSeedProvisional.current = !holdingsLoaded;
      setFromToken(fromCandidates[0]);
      return;
    }

    // Holdings landed after a provisional seed. Re-apply the intent above (From
    // defaults to a token the account holds), which the cold-start ordering
    // otherwise defeats: on first visit the effect always runs against an empty
    // portfolio, so From would keep whichever token happened to sort first in
    // the swappable universe.
    if (fromSeedProvisional.current && holdingsLoaded) {
      fromSeedProvisional.current = false;
      const held = tokens[0];
      setFromToken(held);
      if (toToken?.sacContractId === held.sacContractId) {
        setToToken(swappableTokens.find((t) => t.sacContractId !== held.sacContractId) ?? null);
      }
      return;
    }

    if (!toToken && swappableTokens.length > 0) {
      const fromSac = fromToken?.sacContractId ?? fromCandidates[0]?.sacContractId;
      setToToken(swappableTokens.find((t) => t.sacContractId !== fromSac) ?? null);
    }
  }, [tokens, swappableTokens, fromToken, toToken]);

  const rotation = useSharedValue(90);
  const animatedIconStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const animatedIconStyle2 = useAnimatedStyle(() => ({
    transform: [{ rotate: '90deg' }],
  }));

  const handleSwap = () => {
    fromSeedProvisional.current = false;
    rotation.value = withTiming(rotation.value + 180, { duration: 300 });
    setFromToken(toToken);
    setToToken(fromToken);
  };

  const formik = useFormik({
    initialValues: { amount: '' },
    validationSchema: Yup.object({
      amount: Yup.number().positive().required(),
    }),
    onSubmit: () => {},
  });

  const handleAmountChange = (text: string) => {
    // Strip commas, allow only digits and a single decimal point
    const stripped = text.replace(/,/g, '').replace(/[^0-9.]/g, '');
    const parts = stripped.split('.');
    const sanitized = parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : stripped;
    formik.setFieldValue('amount', sanitized);
  };

  // Debounce the amount so we don't hit the aggregator on every keystroke.
  const [debouncedAmount, setDebouncedAmount] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebouncedAmount(formik.values.amount), 300);
    return () => clearTimeout(id);
  }, [formik.values.amount]);

  // Tab screens stay mounted, so leaving the tab clears nothing on its own —
  // the typed amount and its quote would still be on screen, with Approve
  // still armed, when the user comes back minutes later. Clear on blur.
  // Read through a ref: Formik hands back a new object every render, so
  // depending on it directly would re-run this effect (and its cleanup) on
  // every keystroke and wipe the field as it is typed.
  const formikRef = useRef(formik);
  formikRef.current = formik;
  // Pushing the confirm screen also blurs this one, but that is still the same
  // swap in progress — backing out of confirm should return to what was typed.
  const goingToConfirm = useRef(false);
  useFocusEffect(
    useCallback(() => {
      goingToConfirm.current = false;
      return () => {
        if (goingToConfirm.current) return;
        formikRef.current.resetForm();
        setDebouncedAmount('');
      };
    }, []),
  );

  const {
    data: quote,
    isFetching: quoteFetching,
    error: quoteError,
  } = useSwapQuote({
    fromSacId: fromToken?.sacContractId,
    toSacId: toToken?.sacContractId,
    amountIn: debouncedAmount,
    slippageBps,
    providerId: provider.id,
    fromCode: fromToken?.code,
    toCode: toToken?.code,
  });
  // A debounce gap or an in-flight refetch means "waiting", not "no route".
  const quotePending = quoteFetching || debouncedAmount !== formik.values.amount;
  const badPrice = quoteError instanceof ImplausibleQuoteError && !quotePending;
  const noRoute = !!quoteError && !quotePending && !badPrice;

  const fromBalance = parseFloat(balanceOf(fromToken));
  const amountNum = parseFloat(formik.values.amount || '0');
  const insufficient = amountNum > fromBalance;
  const canApprove =
    !!fromToken && !!toToken && amountNum > 0 && !insufficient && !!quote && !quotePending;

  const handleApprove = () => {
    if (!canApprove || !fromToken || !toToken) return;
    goingToConfirm.current = true;
    router.push({
      pathname: '/swap/confirm',
      params: {
        fromSacId: fromToken.sacContractId,
        fromCode: fromToken.code,
        fromIssuer: fromToken.issuer ?? '',
        toSacId: toToken.sacContractId,
        toCode: toToken.code,
        toIssuer: toToken.issuer ?? '',
        amountIn: formik.values.amount,
        slippageBps: String(slippageBps),
        providerId: provider.id,
      },
    });
  };

  const handleSelectToken = (token: SwapToken) => {
    fromSeedProvisional.current = false;
    if (pickerSide === 'from') {
      if (token.sacContractId === toToken?.sacContractId) setToToken(fromToken);
      setFromToken(token);
    } else if (pickerSide === 'to') {
      if (token.sacContractId === fromToken?.sacContractId) setFromToken(toToken);
      setToToken(token);
    }
    setPickerSide(null);
  };

  const fromValue = formatUsd(formik.values.amount, prices?.[fromToken?.code ?? '']?.price);
  const toAmount = quote?.amountOut ?? '0.00';
  const toValue = formatUsd(quote?.amountOut ?? '0', prices?.[toToken?.code ?? '']?.price);

  const fromUsdPrice = parseFloat(prices?.[fromToken?.code ?? '']?.price ?? '0');
  const rateLabel =
    quote && fromToken && toToken
      ? showUsdRate
        ? `1 ${fromToken.code} ≈ $${fromUsdPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`
        : `1 ${fromToken.code} ≈ ${quote.rate.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${toToken.code}`
      : '—';

  return (
    <Box flex={1} backgroundColor="onboardingbg" style={{ paddingTop: insets.top }}>
<StatusBar style={isDark ? 'light' : 'dark'} />

      {/* Header */}
      <Box
        flexDirection="row"
        alignItems="center"
        justifyContent="center"
        paddingHorizontal="m"
        style={styles.header}
      >
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={24} color={theme.colors.textPrimary} />
        </TouchableOpacity>
        <Text variant="h10" color="textPrimary" fontFamily={'SFproSemibold'}>
          Swap
        </Text>
      </Box>

      <ScrollView
        {...tabBarScroll}
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        // `bounces={false}` was removed rather than tightened: iOS drives
        // RefreshControl off the overscroll bounce, and any narrowing of it
        // (alwaysBounceVertical) makes the pull unreachable whenever the form is
        // shorter than the viewport.
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={theme.colors.primary700}
          />
        }
        style={{ flex: 1 }}
      >
        <Box paddingHorizontal="m" paddingTop="m">
          {/* From Section Header */}
          <Box
            flexDirection="row"
            alignItems="center"
            justifyContent="space-between"
            marginBottom="s"
          >
            <Text variant="p7" color="textSecondary">
              From
            </Text>
            {/* Non-functional placeholder toggle from the original mock — see
                the useExchangeBalance declaration above. */}
            {/* <Box flexDirection="row" alignItems="center">
              <Text variant="p7" color="textSecondary" style={styles.exchangeLabel}>
                Use Exchange Balance
              </Text>
              <Switch value={useExchangeBalance} onValueChange={setUseExchangeBalance} />
            </Box> */}
          </Box>

          {/* First Swap Card (From) */}
          <SwapCard
            tokenName={fromToken?.code ?? '—'}
            tokenSubtitle={fromToken?.code ? `${fromToken.code} on Stellar` : 'Select a token'}
            tokenIcon={fromIconUrl ? { uri: fromIconUrl } : swapTokenImage(fromToken?.code)}
            amount={formik.values.amount}
            onAmountChange={handleAmountChange}
            value={fromValue}
            walletName="My Wallet"
            walletBalance={`${balanceOf(fromToken)} ${fromToken?.code ?? ''}`}
            walletValue={`${balanceOf(fromToken)} ${fromToken?.code ?? ''}`}
            showAddFunds={insufficient}
            showWalletDropdown
            onTokenSelect={() => setPickerSide('from')}
          />

          {/* Swap button + From label for second section */}
          <Box flexDirection="row" alignItems="center" mt={'m'} mb={'xs'}>
            <Text variant="p7" color="textSecondary">
              To
            </Text>
            <Box
              flex={1}
              alignItems="center"
              position={'absolute'}
              left={'43%'}
              top={-25}
              style={{ zIndex: 99999, elevation: 9999 }}
            >
              <TouchableOpacity onPress={handleSwap} activeOpacity={0.8}>
                <Box
                  width={56}
                  height={56}
                  borderRadius={28}
                  backgroundColor="primary"
                  justifyContent="center"
                  alignItems="center"
                >
                  <Animated.View style={animatedIconStyle}>
                    <SwapIcon width={24} color="#000000" />
                  </Animated.View>
                </Box>
              </TouchableOpacity>
            </Box>
          </Box>

          {/* Second Swap Card (To) */}
          <SwapCard
            tokenName={toToken?.code ?? '—'}
            tokenSubtitle={toToken?.code ? `${toToken.code} on Stellar` : 'Select a token'}
            tokenIcon={toIconUrl ? { uri: toIconUrl } : swapTokenImage(toToken?.code)}
            amount={toAmount}
            value={toValue}
            walletName="My Wallet"
            walletBalance={`${balanceOf(toToken)} ${toToken?.code ?? ''}`}
            walletValue={`${balanceOf(toToken)} ${toToken?.code ?? ''}`}
            showAddFunds={false}
            showWalletDropdown
            onTokenSelect={() => setPickerSide('to')}
          />

          {/* Approve Swap Button */}
          <TouchableOpacity
            activeOpacity={0.8}
            style={styles.enterAmountButton}
            disabled={!canApprove}
            onPress={handleApprove}
          >
            <Box
              height={56}
              backgroundColor={canApprove ? 'primary' : 'bg900'}
              borderRadius={28}
              justifyContent="center"
              alignItems="center"
              flexDirection={'row'}
              gap={'sm'}
            >
              {quotePending && <ActivityIndicator color={theme.colors.textPrimary} />}
              <Text
                variant="h10"
                color={quotePending || insufficient || !amountNum ? 'white' : 'bgDark900'}
                style={{ fontWeight: '600' }}
              >
                {!amountNum
                  ? 'Enter Amount'
                  : insufficient
                    ? 'Insufficient Balance'
                    : quotePending
                      ? 'Fetching Quote…'
                      : badPrice
                        ? 'Price unavailable — try again'
                        : noRoute
                          ? 'No route for this pair'
                          : 'Approve Swap'}
              </Text>
            </Box>
          </TouchableOpacity>

          {/* Swap Details — Route row is always shown when an amount is entered so
              the user can switch providers even when the current one has no usable
              quote. Rate/slippage/min-received are only meaningful once a quote
              has come back, so they stay behind the quote guard. */}
          {fromToken && toToken && amountNum > 0 && (
            <Box mt="xl">
              {/* Route / provider picker row */}
              <Box flexDirection="row" justifyContent="space-between" alignItems="center" mb="m">
                <Text variant="p7" color="textSecondary">
                  Route
                </Text>
                {availableProviders.length < 2 ? (
                  // Single-provider network (testnet) — show the provider name
                  // with a label instead of a dead tappable control.
                  <Box flexDirection="row" alignItems="center">
                    <Image
                      source={provider.icon}
                      style={{ width: 24, height: 24, borderRadius: 6, marginRight: 8 }}
                    />
                    <Text variant="p7" color="textPrimary" style={{ marginRight: 8 }}>
                      {provider.name}
                    </Text>
                    <Box
                      paddingHorizontal="s"
                      paddingVertical="xs"
                      borderRadius={4}
                      style={{ backgroundColor: '#1A1A2E' }}
                    >
                      <Text variant="p8" color="textSecondary" style={{ fontSize: 10 }}>
                        Only on this network
                      </Text>
                    </Box>
                  </Box>
                ) : (
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={() => setShowRoutePicker(true)}
                    style={{ flexDirection: 'row', alignItems: 'center' }}
                  >
                    <Image
                      source={provider.icon}
                      style={{ width: 24, height: 24, borderRadius: 6, marginRight: 8 }}
                    />
                    <Text variant="p7" color="textPrimary" style={{ marginRight: 8 }}>
                      {provider.name}
                    </Text>
                    {provider.id === availableProviders[0]?.id && (
                      <Box
                        backgroundColor="bg800"
                        paddingHorizontal="s"
                        paddingVertical="xs"
                        borderRadius={4}
                        style={{ backgroundColor: '#211B0C' }}
                      >
                        <Text variant="p8" color="primary" style={{ fontSize: 10 }}>
                          Recommend
                        </Text>
                      </Box>
                    )}
                    <Ionicons
                      name="chevron-forward"
                      size={14}
                      color={theme.colors.textSecondary}
                      style={{ marginLeft: 8 }}
                    />
                  </TouchableOpacity>
                )}
              </Box>

              {/* Quote-dependent rows — only render once we have a real result */}
              {quote && toToken && (
                <>
                  <Box flexDirection="row" justifyContent="space-between" alignItems="center" mb="m">
                    <Text variant="p7" color="textSecondary">
                      Rate
                    </Text>
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() => setShowUsdRate((v) => !v)}
                      style={{ flexDirection: 'row', alignItems: 'center' }}
                    >
                      <Text variant="p7" color="textPrimary" style={{ marginRight: 4 }}>
                        {rateLabel}
                      </Text>
                      <Animated.View style={animatedIconStyle2}>
                        <SwapIcon width={14} color={theme.colors.white} />
                      </Animated.View>
                    </TouchableOpacity>
                  </Box>

                  <Box flexDirection="row" justifyContent="space-between" alignItems="center" mb="m">
                    <Text variant="p7" color="textSecondary">
                      Slippage
                    </Text>
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() => setShowSlippageOptions((v) => !v)}
                      style={{ flexDirection: 'row', alignItems: 'center' }}
                    >
                      <Text variant="p7" color="textPrimary" style={{ marginRight: 4 }}>
                        {(slippageBps / 100).toFixed(slippageBps % 100 === 0 ? 1 : 2)}%
                      </Text>
                      <Ionicons
                        name={showSlippageOptions ? 'chevron-up' : 'chevron-down'}
                        size={14}
                        color={theme.colors.textSecondary}
                      />
                    </TouchableOpacity>
                  </Box>

                  {showSlippageOptions && (
                    <Box flexDirection="row" alignItems="center" mb="m" flexWrap="wrap">
                      {[10, 50, 100].map((bps) => {
                        const selected = slippageBps === bps && !customSlippage;
                        return (
                          <TouchableOpacity
                            key={bps}
                            activeOpacity={0.7}
                            onPress={() => {
                              setCustomSlippage('');
                              setSlippageBps(bps);
                            }}
                            style={{ marginRight: 8 }}
                          >
                            <Box
                              paddingHorizontal="m"
                              paddingVertical="s"
                              borderRadius={8}
                              backgroundColor={selected ? 'primary' : 'bg900'}
                            >
                              <Text variant="p8" color={selected ? 'bgDark900' : 'textPrimary'}>
                                {(bps / 100).toFixed(1)}%
                              </Text>
                            </Box>
                          </TouchableOpacity>
                        );
                      })}
                      <Box
                        flexDirection="row"
                        alignItems="center"
                        paddingHorizontal="m"
                        paddingVertical="s"
                        borderRadius={8}
                        backgroundColor="bg900"
                      >
                        <TextInput
                          style={styles.slippageInput}
                          value={customSlippage}
                          onChangeText={applyCustomSlippage}
                          placeholder="Custom"
                          placeholderTextColor={theme.colors.textSecondary}
                          keyboardType="decimal-pad"
                        />
                        <Text variant="p8" color="textSecondary">
                          %
                        </Text>
                      </Box>
                    </Box>
                  )}

                  <Box flexDirection="row" justifyContent="space-between" alignItems="center" mb="m">
                    <Text variant="p7" color="textSecondary">
                      Min. Received
                    </Text>
                    <Text variant="p7" color="textPrimary">
                      {quote.minReceived} {toToken.code}
                    </Text>
                  </Box>

                  <Box flexDirection="row" justifyContent="space-between" alignItems="center" mb="m">
                    <Text variant="p7" color="textSecondary">
                      Price Impact
                    </Text>
                    <Text variant="p7" color="textPrimary">
                      {quote.priceImpactPct.toFixed(2)}%
                    </Text>
                  </Box>

                  <Box flexDirection="row" justifyContent="space-between" alignItems="center" mb="m">
                    <Text variant="p7" color="textSecondary">
                      Network Fee
                    </Text>
                    <Text variant="p7" color="textPrimary">
                      Sponsored
                    </Text>
                  </Box>
                </>
              )}
            </Box>
          )}
        </Box>
      </ScrollView>

      <SwapTokenPickerSheet
        visible={pickerSide !== null}
        title={pickerSide === 'from' ? 'Swap From' : 'Swap To'}
        tokens={swappableTokens}
        excludeSacId={pickerSide === 'from' ? toToken?.sacContractId : fromToken?.sacContractId}
        onClose={() => setPickerSide(null)}
        onSelect={handleSelectToken}
      />

      <SwapRoutePickerSheet
        visible={showRoutePicker}
        providers={availableProviders}
        selectedId={provider.id}
        onClose={() => setShowRoutePicker(false)}
        onSelect={(id) => {
          // Invalidate the cache for the previous provider so keepPreviousData
          // doesn't show stale data from the old provider while the new quote
          // is in flight.
          queryClient.invalidateQueries({ queryKey: ['swap-quote'] });
          setSelectedProviderId(id);
          setShowRoutePicker(false);
        }}
      />
    </Box>
  );
};

const styles = StyleSheet.create({
  header: {
    height: 52,
  },
  backButton: {
    position: 'absolute',
    left: 16,
  },
  exchangeLabel: {
    marginRight: 8,
  },
  enterAmountButton: {
    marginTop: 40,
  },
  slippageInput: {
    minWidth: 44,
    padding: 0,
    fontSize: 12,
    fontFamily: 'SFproRegular',
    color: '#FFFFFF',
    textAlign: 'right',
  },
});

export default Swap;
