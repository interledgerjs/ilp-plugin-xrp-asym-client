# ILP Plugin XRP Asym Client

This plugin allows a user to create a payment channel to a connector without
the connector having to add an entry to their list of peers. It is therefore
very useful for creating your own sub-connector. The client plugin first opens
a channel to the server, and then informs the server of this channel while
providing proof that it controls it. If the proof is satisfactory and the
channel contains at least 10 XRP (to prevent a DoS attack), the server will
open a channel back to the client for carrying incoming funds.

Persistent state is not required to run this plugin, even though it makes use
of payment channels. When your peer wants you to sign a new claim, they will
first give you the best claim of yours that they have seen. This plugin will
then verify that claim and sign a higher one. In this way, the best outgoing
claim does not have to be stored.

For incoming funds, the connector will give you a signed claim for the amount
they owe you. This claim signature is verified against payment channel details,
and against an internally kept balance. This balance is set by loading the
payment channel details at every start up. If persistence is enabled, this
incoming balance will be loaded from the provided store.

ILP Plugin XRP Asym Client is based off of
[`ilp-plugin-btp`](https://github.com/interledgerjs/ilp-plugin-btp). The ILP
Plugin XRP Asym Server is located
[here](https://github.com/interledgerjs/ilp-plugin-xrp-asym-server).

```js
const clientPlugin = new IlpPluginXrpAsymClient({
  // The BTP address of the asymmetric server plugin. The `btp_secret`
  // in here is hashed to become the account name. Note that if you switch
  // XRP accounts, you also have to switch `btp_secret`s
  server: 'btp+ws://:btp_secret@localhost:6666',

  // Rippled server for client use
  xrpServer: 'wss://s.altnet.rippletest.net:51233',

  // XRP secret. The address can be dynamically determined from this,
  // or can be specified as a separate option.
  secret: 'ss1oM64ccuJuX9utz5pdPRuu5QKMs',

  // A store can be optionally passed in to save claims in case of a crash.
  // If no store is present, then the best claim will be submitted on plugin
  // disconnect, as well as once every five minutes (interval is configurable
  // via claimInterval)
  _store: new Store(),

  // Interval on which to claim funds from channel. Defaults to 5 minutes.
  claimInterval: 5 * 60 * 1000
})
```
