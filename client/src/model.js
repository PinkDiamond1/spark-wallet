import big from 'big.js'
import { Observable as O } from './rxjs'
import { dbg, formatAmt, combine, combineAvail, extractErrors, dropErrors } from './util'


const
  sumOuts  = outs  => outs.reduce((T, o) => T + o.value, 0)
, sumChans = chans => chans.filter(c => c.state === 'CHANNELD_NORMAL').reduce((T, c) => T + c.msatoshi_to_us, 0)
, sumPeers = peers => peers.filter(p => p.channels).reduce((T, p) => T + sumChans(p.channels), 0)
, updPaid  = (invs, paid) => invs.map(i => i.label === paid.label ? { ...i, ...paid  } : i)

, idx = xs => x => xs.indexOf(x)
, idn = x => x

const
  themes   = 'cerulean cosmo cyborg dark darkly flatly journal litera lumen lux materia minty pulse sandstone simplex sketchy slate solar spacelab superhero united yeti'.split(' ')
, units    = 'sat bits milli btc usd'.split(' ')
, unitrate = { sat: 0.001, bits: 0.00001, milli: 0.00000001, btc: 0.00000000001 }
, unitstep = { ...unitrate, usd: 0.00001 }

const defaultServer = process.env.BUILD_TARGET === 'web' ? '.' : null

module.exports = ({ dismiss$, saveConf$, togExp$, togTheme$, togUnit$, page$, goRecv$
                  , amtVal$, execRpc$, execRes$, clrHist$, feedStart$, conf$: savedConf$
                  , req$$, error$, invoice$, incoming$, outgoing$, funds$, payments$, invoices$, btcusd$, info$, peers$ }) => {
  const

  // Periodically re-sync from listpayments,
  // continuously patch with known outgoing payments
    freshPays$ = O.merge(
      payments$.map(payments => _ => payments)
    , outgoing$.map(pay => payments => [ ...payments, { ...pay, status: 'complete', created_at: Date.now()/1000|0 } ])
    ).startWith([]).scan((payments, mod) => mod(payments))

  // Periodically re-sync from listinvoices,
  // continuously patch with known invoices (paid only)
  , freshInvs$ = O.merge(
      invoices$.map(invs => _ => invs)
    , invoice$.map(inv  => invs => [ ...invs, inv ])
    , incoming$.map(inv => invs => updPaid(invs, inv))
    )
    .startWith([]).scan((invs, mod) => mod(invs))
    .map(invs => invs.filter(inv => inv.status === 'paid'))

  // Chronologically sorted feed of incoming and outgoing payments
  , feed$     = O.combineLatest(freshInvs$, freshPays$, (invoices, payments) => [
      ...invoices.map(inv => [ 'in',  inv.paid_at,    inv.msatoshi_received, inv ])
    , ...payments.map(pay => [ 'out', pay.created_at, pay.msatoshi,          pay ])
    ].sort((a, b) => b[1] - a[1]))

  // Periodically re-sync channel balance from "listpeers",
  // continuously patch with known incoming & outgoing payments
  , cbalance$ = O.merge(
      peers$.map(peers  => _ => sumPeers(peers))
    , incoming$.map(inv => N => N + inv.msatoshi_received)
    , outgoing$.map(pay => N => N - pay.msatoshi_sent)
    ).startWith(null).scan((N, mod) => mod(N)).distinctUntilChanged()

  // On-chain outputs balance (not currently used for anything, but seems useful?)
  , obalance$ = funds$.map(funds => sumOuts(funds.outputs || []))

  // Config options
  , conf     = (name, def, list) => savedConf$.first().map(c => c[name] || def).map(list ? idx(list) : idn)
  , server$  = conf('server', defaultServer).concat(saveConf$.map(C => C.server))
  , expert$  = conf('expert', false)        .concat(togExp$)  .scan(x => !x)
  , theme$   = conf('theme', 'yeti', themes).concat(togTheme$).scan((n, a) => (n+a) % themes.length).map(n => themes[n])
  , unit$    = conf('unit',  'sat',  units) .concat(togUnit$) .scan((n, a) => (n+a) % units.length) .map(n => units[n])
  , conf$    = combine({ server$, expert$, theme$, unit$ })

  // Currency & unit conversion handling
  , msatusd$ = btcusd$.map(rate => big(rate).div(100000000000)).startWith(null)
  , rate$    = O.combineLatest(unit$, msatusd$, (unit, msatusd) => unitrate[unit] || msatusd)
  , unitf$   = O.combineLatest(unit$, rate$, (unit, rate) => msat => `${rate ? formatAmt(msat, rate, unitstep[unit]) : '⌛'} ${unit}`)

  // Payment amount field handling, shared for creating new invoices and paying custom amounts
  , amtMsat$ = amtVal$.withLatestFrom(rate$, (amt, rate) => amt && rate && big(amt).div(rate).toFixed(0) || '')
                      .merge(page$.mapTo(null)).startWith(null)
  , amtData$ = combine({
      msatoshi: amtMsat$
    , amount:   unit$.withLatestFrom(amtMsat$, rate$, (unit, msat, rate) => formatAmt(msat, rate, unitstep[unit], false))
                     .merge(goRecv$.mapTo(''))
    , unit:     unit$
    , step:     unit$.map(unit => unitstep[unit])
    })

  // Keep track of the number of non-backgground in-flight requests
  , loading$ = req$$.filter(({ request: r }) => !(r.ctx && r.ctx.bg))
      .flatMap(r$ => r$.catch(_ => O.of(null)).mapTo(-1).startWith(+1))
      .startWith(0).scan((N, a) => N+a)

  // User-visible alert messages
  , alert$ = O.merge(
      error$.map(err  => [ 'danger', ''+err ])
    , incoming$.map(i => [ 'success', `Received payment of @{{${i.msatoshi_received}}}` ])
    , outgoing$.map(i => [ 'success', `Sent payment of @{{${i.msatoshi}}}` ])
    , saveConf$.switchMap(_ => O.timer(1)).mapTo([ 'success', 'Settings saved successfully' ])
    , dismiss$.mapTo(null)
    ).combineLatest(unitf$, (alert, unitf) => alert && [ alert[0], fmtAlert(alert[1], unitf) ])

  , fmtAlert = (s, unitf) => s.replace(/@\{\{(\d+)\}\}/g, (_, msat) => unitf(msat))

  // RPC console history
  , rpcHist$ = execRes$.startWith([]).merge(clrHist$.mapTo('clear'))
      .scan((xs, x) => x === 'clear' ? [] : [ x, ...xs ].slice(0, 20))

  dbg({ loading$, alert$, rpcHist$ }, 'spark:model')
  dbg({ error$ }, 'spark:error')
  dbg({ savedConf$, conf$, expert$, theme$, unit$, conf$ }, 'spark:config')

  return combineAvail({
    conf$, page$, loading$, alert$
  , info$, peers$, funds$
  , btcusd$, unitf$, cbalance$, obalance$
  , feed$, feedStart$
  , amtData$, rpcHist$
  }).shareReplay(1)
}
