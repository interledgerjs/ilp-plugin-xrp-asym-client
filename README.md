# ILP Plugin XRP Asym Client

```
const clientPlugin = new IlpPluginXrpAsymClient({
  // The BTP address of the asymmetric server plugin. The `btp_secret`
  // in here is hashed to become the account name. Note that if you switch
  // XRP accounts, you also have to switch `btp_secret`s
  server: 'btp+ws://:btp_secret@localhost:6666',

  // Rippled server for client use
  xrpServer: 'wss://s.altnet.rippletest.net:51233'

  // XRP secret. The address can be dynamically determined from this,
  // or can be specified as a separate option.
  secret: 'ss1oM64ccuJuX9utz5pdPRuu5QKMs'
})
```
