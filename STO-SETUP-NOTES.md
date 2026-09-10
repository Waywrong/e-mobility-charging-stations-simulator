# OCPP 測試環境建置筆記：e-mobility-charging-stations-simulator ↔ STO (SteVe)

記錄於 2026-07-22。目的：重建「STO(CSMS) + 充電樁模擬器」測試環境時可依此重做，不必重新踩雷。

## 背景與關鍵判斷

- **CSMS 是 STO，本質是 SteVe fork，只支援 OCPP 1.6-J**（不支援 2.0.1）。
  確認方式：`docker logs ocpp16_srv_app` 開頭會印出：
  ```
  STO202605a:WebSocket/JSON endpoint for OCPP
  - ws://<ip>:3080/sto/websocket/CentralSystemService/(chargeBoxId)
  ```
- 原本想用 `~/projects/everest-demo`，但該 repo 已在 2024/11 的 commit `77bf991`
  「🔥 Remove support for OCPP 1.6J」把 SteVe/OCPP1.6 demo 整套移除，
  現在的腳本 (`demo-iso15118-2-ocpp-201.sh`) 只接 OCPP 2.0.1 的 MaEVe / CitrineOS，
  **無法接 STO**。因此改用 SAP 的 `e-mobility-charging-stations-simulator`
  （支援 OCPP 1.6 / 2.0.x，純 Node.js，不需要整套 EVerest 編譯）。

## 前置需求 & 安裝

repo 要求 Node **>=22**、pnpm **>=10.9**，但系統原生只有 Node 18.19.1，
且沒有 sudo 免密碼，所以用 **nvm**（裝在 `~/.nvm`，不需 root）：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm install 22
nvm use 22
corepack enable
corepack prepare pnpm@latest --activate
```

之後每次開新 shell 要跑模擬器，記得先：
```bash
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"; nvm use 22
```

安裝套件：
```bash
cd ~/projects/e-mobility-charging-stations-simulator
pnpm install
```

## 設定檔

初始化（第一次要 copy template）：
```bash
cp src/assets/config-template.json src/assets/config.json
cp src/assets/idtags-template.json src/assets/idtags.json
```

### `src/assets/config.json` 的修改重點

- `supervisionUrls`：指向 STO 的 base URL（**不含 chargeBoxId**，模擬器會自己在後面補上
  `/<chargingStationId>`）：
  ```json
  "supervisionUrls": ["ws://127.0.0.1:3080/sto/websocket/CentralSystemService"]
  ```
- `uiServer.enabled`：要用瀏覽器 Web UI 監控/操作才需要開（見下面「Web UI」章節）；
  只是單純連 STO 測試連線/ATG 的話，維持 template 預設的 `false` 也完全沒問題。
- `log.console: true`：方便直接看 log（預設只寫檔案）。
- `stationTemplateUrls`：只留一個 template，測試用：
  ```json
  "stationTemplateUrls": [
    { "file": "siemens.station-template.json", "numberOfStations": 1 }
  ]
  ```

### `src/assets/idtags.json`

STO 資料庫裡目前只有一張已註冊的 RFID/idTag：`stoIdtag202604j`
（在 `ocpp_tag` table 裡，備註是 `stoTag`）。所以把 idtags.json 改成：
```json
["stoIdtag202604j"]
```
如果用預設的 `UNDEFINED` / `BB2TBR09`，STO 會回 Authorize `Invalid`，
之後 ATG 的交易會一直失敗重試。

### `src/assets/station-templates/siemens.station-template.json`

- 這個 template 沒寫 `ocppVersion`，預設就是 **OCPP 1.6**（2.0.x 的 template，例如
  `keba-ocpp2.station-template.json`，才會明寫 `"ocppVersion": "2.0.1"`）。
- `fixedName: true` + `baseName` → 模擬出來的 chargingStationId **就是**
  `baseName` 的值（沒有 index 後綴）。程式邏輯在 `src/charging-station/HelpersId.ts`
  的 `getChargingStationId()`。**目前用的值是 `"1060101"`**（原本測試用
  `"CS-SIEMENS"`，2026-07-22 改過一次，見下方「改 ChargeBox ID」）。
  改這個欄位屬於程式碼/資源檔（`src/assets/...`），**改完要 `pnpm build`**
  （或直接 `./ctl.sh start`/`restart`，裡面本來就會 build）才會生效，因為
  執行期讀的是 `dist/assets/station-templates/`，不是 `src/`。

#### 改 ChargeBox ID 的完整步驟（實測過，2026-07-22 把 `CS-SIEMENS` 改成 `1060101`）

1. 改 `baseName`（見上面）
2. 去 STO 註冊新的 chargeBoxId（STO 不接受未註冊的 ID）：
   ```bash
   docker exec ocpp16_srv_db mysql -u steve -p'<DB_PASSWORD>' stevedb \
     -e "INSERT INTO charge_box (charge_box_id, insert_connector_status_after_transaction_msg) VALUES ('1060101', 0);"
   ```
3. chargingStationId 變了 → hashId 也變了 → 舊的持久化設定檔
   （`dist/assets/configurations/<舊hashId>.json`）變成孤兒檔，清掉：
   ```bash
   rm -f dist/assets/configurations/*.json
   ```
4. `./ctl.sh stop && ./ctl.sh start`（內建會 `pnpm build`）
5. 雙邊驗證：
   - 模擬器 log 應該看到 `Charging station 1060101 (hashId: ...)`、
     連到 `.../CentralSystemService/1060101`、`BootNotification ... 'Accepted'`
   - STO DB 反查：
     ```bash
     docker exec ocpp16_srv_db mysql -u steve -p'<DB_PASSWORD>' stevedb \
       -e "SELECT charge_box_id, charge_point_vendor, charge_point_model, last_heartbeat_timestamp FROM charge_box WHERE charge_box_id='1060101';"
     ```
     要看到 vendor/model 有值、`last_heartbeat_timestamp` 是剛剛的時間
   - 開 http://localhost:3030 確認卡片標題變成新 ID、`STARTED`/`WS OPEN`/`Accepted`

舊的 `CS-SIEMENS` 那筆在 STO 的 `charge_box` table 裡沒有刪，留著無害
（不會有東西再去連它），要清的話自己去 STO 網頁或 DB 刪即可。

#### SetChargingProfile 回 `NotSupported` 的問題（2026-07-22 修好）

STO 呼叫 `POST /api/v1/transactions/set_charge_profile`（送 OCPP `SetChargingProfile`）
時，模擬器原本回 `{"status":"NotSupported"}`。

**原因**：`OCPP16IncomingRequestService.handleRequestSetChargingProfile` 會先檢查
`SupportedFeatureProfiles` 這個 configurationKey 裡有沒有 `SmartCharging`
（程式碼在 `src/charging-station/Helpers.ts` 的 `hasFeatureProfile()` +
`OCPP16ServiceUtils.checkFeatureProfile()`）。siemens template 原本的值是
`"Core,LocalAuthListManagement,Reservation"`，沒有 `SmartCharging`，所以整個
request 在做任何實際處理之前就先被擋掉回 `NotSupported`。

**修法**：把 `src/assets/station-templates/siemens.station-template.json` 裡
`SupportedFeatureProfiles` 的 `value` 加上 `SmartCharging`：
```json
{
  "key": "SupportedFeatureProfiles",
  "readonly": true,
  "value": "Core,LocalAuthListManagement,Reservation,SmartCharging"
}
```
跟改 `baseName` 一樣，這是 configurationKey，且 `ocppPersistentConfiguration`
預設是 true，**改完一樣要清 `dist/assets/configurations/*.json` 再
`ctl.sh stop && ctl.sh start`**，不然舊的持久化設定會蓋掉新加的 `SmartCharging`。

**驗證方式**：改完後，把 `src/assets/config.json` 的 `log.level` 暫時改成
`"debug"`（預設是 info，不會印出 `SetChargingProfile` 成功處理的訊息），重啟後
重送同一支 curl，在 `run/simulator.log` 應該看到：
```
debug: ... OCPPRequestService.internalSendMessage: >> Command 'SetChargingProfile' sent response payload: [3,"...",{"status":"Accepted"}]
```
驗證完記得把 `log.level` 改回去（拿掉這個欄位、恢復預設），再重啟一次。

註：`handleRequestSetChargingProfile` 還有其他會回 `Rejected` 的條件（例如
`connectorId` 不存在、`TxProfile` 但該 connector 沒有進行中的交易等），
如果之後測其他 charging profile 情境回 `Rejected` 而非 `Accepted`，先看
是不是踩到這些條件，不一定是同一個 `SmartCharging` 問題。

#### TriggerMessage(StatusNotification) 回 `NotImplemented` 的問題（2026-07-22 修好）

STO 呼叫 `POST /api/v1/transactions/trigger_message`（`triggerMessage: "StatusNotification"`）
時，模擬器原本回 `{"status":"NotImplemented"}`，而且**就算修好回應狀態，也不會真的
補送 StatusNotification**——這是模擬器程式碼本身缺兩塊，跟 SetChargingProfile 只需要
改設定檔不一樣，這次真的動了 `src/` 的程式邏輯。

**原因 1（跟 SmartCharging 一樣的模式）**：`handleRequestTriggerMessage` 一樣會先檢查
`SupportedFeatureProfiles` 裡有沒有 `RemoteTrigger`，siemens template 原本沒有，
所以直接被擋掉回 `NotImplemented`。修法一樣是加到 `SupportedFeatureProfiles`：
```json
"value": "Core,LocalAuthListManagement,Reservation,SmartCharging,RemoteTrigger"
```

**原因 2（程式碼本身沒實作，不是設定問題）**：就算 `RemoteTrigger` 加上去，原本
`handleRequestTriggerMessage` 對 `StatusNotification`/`BootNotification`/`Heartbeat`/
`MeterValues`/`Diagnostics-`/`FirmwareStatusNotification` 這幾種 trigger 類型，
**全部都只是直接回 `Accepted`，沒有任何一種會真的去補送對應的訊息**。真實充電樁的行為
是：先回 `TriggerMessage.conf {"status":"Accepted"}`，然後**另外、非同步地**把被
要求的訊息（例如 `StatusNotification`）送出去。

已經在 `src/charging-station/ocpp/1.6/OCPP16IncomingRequestService.ts` 補上
`StatusNotification` 這個 case 的實際行為（其他 5 種 trigger 類型維持原樣，只回
`Accepted`，沒有一併補實作——這次只針對有問到的 `StatusNotification`）：
- 新增 `private async triggerStatusNotification(chargingStation, connectorId?)`：
  如果 request 有帶 `connectorId`，只重送那一個 connector 的**目前狀態**
  （不會改變狀態，只是重新公告一次）；如果沒帶 `connectorId`（這次 curl 就是這樣），
  就用 `chargingStation.iterateConnectors(true)`（`true` = 跳過 connector 0）
  對**每一個實體 connector**都送一次，符合真實充電樁「沒指定 connector 就全部
  connector 都送」的行為（這次實測两個 connector 都有送）。
- `handleRequestTriggerMessage` 的 `StatusNotification` case 呼叫這個新方法但**不 `await`
  它**（fire-and-forget，接 `.catch` 記 log），因為 `TriggerMessage.conf` 要先回，
  StatusNotification 是之後才送的獨立訊息，這跟真實充電樁的時序一致。

一樣要記得：改完 `src/` 程式碼要 `pnpm build`（`ctl.sh start`/`restart` 內建會做），
純程式邏輯改動這次不影響 `dist/assets/configurations/*.json` 的持久化內容
（沒有新增 configurationKey），但因為同時也改了 `SupportedFeatureProfiles`，
一樣要清掉舊的持久化檔重新產生。

**驗證方式**：一樣暫時把 `log.level` 改成 `"debug"`，重送 curl，應該在
`run/simulator.log` 看到：
```
debug: ... ChargingStation.handleIncomingMessage: << Command 'TriggerMessage' received request payload: [2,"...","TriggerMessage",{"requestedMessage":"StatusNotification"}]
debug: ... OCPPRequestService.internalSendMessage: >> Command 'TriggerMessage' sent response payload: [3,"...",{"status":"Accepted"}]
debug: ... OCPPRequestService.internalSendMessage: >> Command 'StatusNotification' sent request payload: [2,"...","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Unavailable"}]
debug: ... OCPPRequestService.internalSendMessage: >> Command 'StatusNotification' sent request payload: [2,"...","StatusNotification",{"connectorId":2,"errorCode":"NoError","status":"Available"}]
```
（connector 1 顯示 `Unavailable` 是因為 siemens template 裡 connector 1 的
`bootStatus` 就設定成 `Unavailable`，不是 bug——這個功能只是「如實重新公告目前狀態」，
不會把狀態改成 `Available`。）驗證完記得把 `log.level` 改回去、重啟一次。

- `AutomaticTransactionGenerator.enable`：**預設維持 `false`**（開機/重啟不會自動跑
  ATG）。要測自動充電交易時，**不要改這個檔案**，改用 Web UI 的 `Start ATG` /
  `Stop ATG` 按鈕手動開關（見下面「Web UI」章節的「站級 ATG 開關」）。
  ```json
  "AutomaticTransactionGenerator": {
    "enable": false,
    "minDuration": 60,
    "maxDuration": 80,
    "minDelayBetweenTwoTransactions": 15,
    "maxDelayBetweenTwoTransactions": 30,
    "probabilityOfStart": 1,
    "stopAfterHours": 0.3,
    "requireAuthorize": true
  }
  ```
  之前踩過的雷：曾經一度改成 `true` 想測試方便，結果變成
  **每次 `ctl.sh stop && ctl.sh start` 都會自動開始跑 ATG**，不是預期行為
  （因為 `enable` 是開機當下的初始狀態，不是「使用者當次手動開的狀態」）。
  已經改回 `false`，之後要看 ATG 行為請一律用 Web UI 按鈕開，不要再改這個欄位。

## STO 端：Charge Profile 功率限制 API（2026-07-23 新增功能）

跟前面幾個「修 e-mobility 讓它正確回應」的項目不同，這個是**改 STO 自己的原始碼**
（`~/projects/blueberry-juice-local-server/ocpp_srv`，也就是 SteVe fork），
新增的是「怎麼下達功率限制」這個操作面的功能，跟充電樁模擬器本身無關。

### 背景

原本 STO 要下 `set_charge_profile`／`clear_charge_profile` 都**必須先**在
`/sto/manager/chargingProfiles` 網頁手動建一筆 charging profile（設定
Power Limit 等欄位），拿到一個 `chargingProfilePk`，之後 API 呼叫都要帶這個 pk。
想隨時改功率限制，就得先去網頁改/建 profile，很不方便。

### 改了什麼

`set_charge_profile` 新增 `powerLimitW`（必要跟 `chargingProfilePk` 互斥擇一）：
```bash
curl -X POST 'http://127.0.0.1:3080/sto/api/v1/transactions/set_charge_profile' \
  -H 'Content-Type: application/json' -H 'STO-API-KEY: <STO_API_KEY>' -d '{
    "chargePointSelectList": [{"chargeBoxId":"1060101","endpointAddress":"","ocppTransport":"JSON"}],
    "connectorId": 0,
    "powerLimitW": 60000
  }'
# -> {"taskID":2,"chargingProfilePk":5}
```
不用先去網頁建 profile，STO 內部會自動組一個 ChargePointMaxProfile/Absolute/W
的 profile 寫進 DB（`description` 標成 `"API set_charge_profile"`，方便在
`/manager/chargingProfiles` 網頁分辨哪些是手動建的、哪些是 API 自動建的），
拿到新 pk 後沿用原本的下發流程。

`clear_charge_profile` 新增 `filterType: "OtherParameters"` 模式，一樣不用帶 pk：
```bash
curl -X POST 'http://127.0.0.1:3080/sto/api/v1/transactions/clear_charge_profile' \
  -H 'Content-Type: application/json' -H 'STO-API-KEY: <STO_API_KEY>' -d '{
    "chargePointSelectList": [{"chargeBoxId":"1060101","endpointAddress":"","ocppTransport":"JSON"}],
    "filterType": "OtherParameters",
    "connectorId": 0,
    "chargingProfilePurpose": "ChargePointMaxProfile",
    "stackLevel": 0
  }'
# -> {"taskID":3}
```
`chargingProfilePurpose` 要用 OCPP 規格字串（如 `"ChargePointMaxProfile"`），
不是 Java enum 名稱（`CHARGE_POINT_MAX_PROFILE`）——這是這次順便修掉的一個坑，
最初這個欄位型別沒轉好，會要求打後者，跟 API 其他地方的慣例不一致。

**舊的 `chargingProfilePk` 用法完全不受影響**，兩個端點都是「新欄位 optional，
帶了就走新模式，不帶就跟以前一樣」。

### 部署方式

改完 `ocpp_srv` 的程式碼後：
```bash
cd ~/projects/blueberry-juice-local-server/ocpp_srv
docker compose build app
docker compose up -d --force-recreate app
```
注意：即使只指定 `app`，因為 `depends_on` 的關係 `db` 服務也會被一併 recreate
（有確認過 `db` 的資料在真正的 docker volume 上，重建不會遺失，charge_box／
ocpp_tag／既有 charging_profile 都會保留）。Maven 是在 container **啟動時**
才 build（不是 `docker compose build` 那一步），且每次 recreate 都是全新
container、`.m2` cache 沒有留著，所以第一次啟動要重新下載全部依賴，會比較久
（實測約 1 分半）。用 `docker logs -f ocpp16_srv_app` 看到 `BUILD SUCCESS` 跟
`Starting......... Done!` 才算真的起來。

### 驗證方式

用 e-mobility 模擬器（chargeBoxId `1060101`）當測試對象，暫時把
`src/assets/config.json` 的 `log.level` 調成 `"debug"`（同前面幾個功能的驗證
手法），送出上面兩支 curl，確認模擬器 log 收到的 OCPP 封包內容正確、且回應都是
`{"status":"Accepted"}`，驗證完記得把 log level 改回去、重啟模擬器。

完整討論脈絡與程式碼改動細節見 `ocpp_srv` 這邊的 commit
`6013b23`（`achi001/blueberry-juice-local-server`）。

## STO 端：註冊 charge box

STO 預設**不會**自動接受未註冊的 chargeBoxId，必須先在 `charge_box` table
建一筆（這跟 STO 網頁的「Add Charge Point」功能本質上是同一個 INSERT，
對照原始碼 `ChargePointRepositoryImpl.addChargePointList()` 只需要
`charge_box_id` 這個欄位）：

```bash
docker exec ocpp16_srv_db mysql -u steve -p'<DB_PASSWORD>' stevedb \
  -e "INSERT INTO charge_box (charge_box_id, insert_connector_status_after_transaction_msg) VALUES ('CS-SIEMENS', 0);"
```

DB 連線資訊（來自 `docker inspect ocpp16_srv_db` 的環境變數）：
- DB 名稱: `stevedb`　user: `steve`　password: `<DB_PASSWORD>`（已輪替，實際值見密碼管理工具，不寫進 repo）

確認已註冊：
```bash
docker exec ocpp16_srv_db mysql -u steve -p'<DB_PASSWORD>' stevedb \
  -e "SELECT charge_box_id, registration_status FROM charge_box;"
```

## ⚠️ 踩雷點：持久化設定會蓋掉 template 的修改

模擬器第一次跑完某個充電樁後，會把「當下的設定」持久化寫到
`dist/assets/configurations/<hashId>.json`（`hashId` 是根據 template 內容算出來的）。
**這個持久化檔案的優先權比 `src/assets/station-templates/*.json` 高**
（尤其 `automaticTransactionGeneratorPersistentConfiguration: true` 時，
ATG 設定會被鎖住不跟著 template 更新）。

所以「改了 template 之後」如果行為沒變，先檢查／清掉對應的持久化檔：
```bash
ls dist/assets/configurations/
rm dist/assets/configurations/<那個 hashId>.json
```
測試環境可以放心刪，下次啟動會用最新的 template 重新產生。

## 停止充電後不自動回 Available：`manualPostTransactionStatus`

真實充電樁停止充電後，槍還插在車上，狀態會停在 `Finishing`，
要等駕駛「拔槍」才回 `Available`。模擬器預設卻是停止交易的同時就送 `Available`，
等於自動幫你拔槍 —— 地端 / 雲端那些「槍還佔用中」的邏輯就測不到。

template 加上這個開關即可還原真實行為（`siemens.station-template.json` 已預設開啟）：

```json
"manualPostTransactionStatus": true
```

行為差異：

| 事件 | 預設 (`false`) | 開啟 (`true`) |
| --- | --- | --- |
| StopTransaction 完成 | `Charging` → `Available` | `Charging` → `Finishing`（停在這裡） |
| 回到 `Available` | 自動 | **手動**：Web UI 點狀態徽章改成 Available，或用 UI WebSocket 的 `statusNotification` |
| 交易中被排程的 ChangeAvailability(Inoperative) | 交易結束送 `Unavailable` | 一樣送 `Unavailable`（不受影響） |

配 `postTransactionDelay` 一起用時，`Finishing` 只會送一次，延遲結束後不會再送 `Available`。

⚠️ 副作用（這是刻意的，不是 bug）：連接器停在 `Finishing` 時
**`RemoteStartTransaction` 會被拒絕**（`OCPP16IncomingRequestService` 明確擋掉 `Finishing`）。
所以「停止充電 → 立刻再遠端啟動」的測試，中間一定要先手動切回 `Available`，
這正好對應現場「沒拔槍就不能開下一筆」的行為。

手動切回 Available 的 CLI 寫法（跟 `authorize-rfid.mjs` 同樣的連線方式）：

```js
await send('statusNotification', { connectorId: 1, hashIds: [hashId], status: 'Available' })
```

## StatusNotification 送出廠牌欄位：`statusNotificationVendorFields`

真實充電樁的 `StatusNotification` 會帶 OCPP 1.6 的選用欄位，模擬器預設只送三個必填欄位：

| 來源 | payload |
| --- | --- |
| 模擬器預設 | `{"connectorId":2,"errorCode":"NoError","status":"Available"}` |
| Phihong/Zerova 真機 | `{"connectorId":1,"errorCode":"NoError","info":"","status":"Available","timestamp":"…","vendorId":"Phihong Technology","vendorErrorCode":""}` |
| Winline/Dover 真機 | `{"connectorId":0,"errorCode":"NoError","status":"Available","info":"No error to report","timestamp":"…","vendorId":"winline","vendorErrorCode":""}` |

少了 `vendorId` 就測不到地端 `sto_charger` 從 `StatusNotification` 認廠牌的那條路徑
（`vendor_map.js`，sto_charger issue #35）——那是真機的主要來源，`BootNotification` 只是備援。
`vendorErrorCode` 缺席同樣讓 `check_is_vendorErrorCode()` 的正規化測不到。

template 加上開關（`siemens.station-template.json` 已預設開啟）：

```json
"statusNotificationVendorFields": true,
"statusNotificationInfo": ""
```

| 欄位 | 值 |
| --- | --- |
| `vendorId` | 取自 template 的 `chargePointVendor` —— **不另設一個值**，才不會出現 Boot 說 A、Status 說 B 這種真機不會有的組合 |
| `info` | `statusNotificationInfo`，預設空字串；要模擬 Dover 就填 `"No error to report"` |
| `timestamp` | 送出當下 |
| `vendorErrorCode` | 空字串（呼叫端有給就用給的，例如故障情境） |

呼叫端明確帶了哪一欄，就以呼叫端的為準，所以要模擬帶錯誤碼的 Faulted 仍然可行。
關閉（預設）時行為與上游完全相同。

換廠牌做混合站測試時只改 `chargePointVendor` 一處，Boot 與 Status 會一起變：

```bash
sed -i 's/"chargePointVendor": ".*"/"chargePointVendor": "winline"/' \
  src/assets/station-templates/siemens.station-template.json
rm -f dist/assets/configurations/*.json   # 不清會沿用舊的 persisted config
./ctl.sh restart
```

## 啟動 / 停止

```bash
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"; nvm use 22
cd ~/projects/e-mobility-charging-stations-simulator
pnpm build        # 或直接用 pnpm start（build+run 一起做）
NODE_ENV=production nohup node dist/start.js > /tmp/simulator.log 2>&1 & disown

# 停止
pkill -f "node dist/start.js"
```

**建議直接用 `ctl.sh`**（見下面「一鍵啟動/關閉腳本」），不用背這些指令。

## 一鍵啟動/關閉腳本：`ctl.sh`

`~/projects/e-mobility-charging-stations-simulator/ctl.sh` 把「模擬器本體 + Web UI」
兩個 process 包成一個腳本管理，手動執行（不是 systemd 開機自動跑，只是開機後
自己手動下一次指令就好）：

```bash
cd ~/projects/e-mobility-charging-stations-simulator
./ctl.sh start     # 依序 build+啟動模擬器、build+啟動 Web UI
./ctl.sh status    # 看兩個 process 是否在跑、PID
./ctl.sh stop      # 兩個都關掉
./ctl.sh restart   # stop 再 start
```

重點設計：
- 會先找 `~/.nvm` 載入 Node 22（不依賴目前 shell 有沒有先 `nvm use`）。
- PID 記錄在 `run/simulator.pid` / `run/webui.pid`（`run/` 已加進 `.gitignore`），
  重複執行 `start` 會偵測已經在跑，不會重複啟動、也不會弄出兩個互搶 port 的行程。
- log 分別在 `run/simulator.log`、`run/webui.log`。
- `stop` 用 PID 精準 kill（先 `TERM` 等最多 5 秒，還沒死才 `KILL`），不是用
  `pkill -f` 亂槍打鳥。

## Web UI（圖形化監控/操作介面）

**這次的操作原本沒有裝這部分**，只用 log + STO DB 反查來驗證。之後如果要用
瀏覽器直接看充電樁狀態、手動下 Start/Stop Transaction、鎖/解鎖 connector，
需要額外啟用並跑起來，步驟如下。

### 架構

兩個獨立的東西：
1. **模擬器本體的 UI Server**：`src/assets/config.json` 裡的 `uiServer`，
   跑在模擬器 process 內，開一個 WebSocket port（預設 8080）讓外部控制。
2. **Web UI**（`ui/web/`）：獨立的 Vue SPA，是給人看的網頁，透過瀏覽器連到上面
   那個 WebSocket port。兩者要分開啟用/啟動。

### 1. 開啟模擬器的 UI Server

編輯 `src/assets/config.json`，把 `uiServer.enabled` 改成 `true`
（`authentication` 預設帳密 `admin`/`admin`，本機測試先不用改）：
```json
"uiServer": {
  "enabled": true,
  "type": "ws",
  ...
  "authentication": { "enabled": true, "type": "protocol-basic-auth", "username": "admin", "password": "admin" }
}
```
改完要 **重新 build + 重啟模擬器**（`pnpm build` 再重新跑 `node dist/start.js`），
純改 `dist/assets/config.json` 也可以但下次 `pnpm build` 會被蓋掉，記得同步改 `src/`。

確認 UI server 有起來：
```bash
ss -tlnp | grep 8080   # 應該看到 127.0.0.1:8080 LISTEN
```

### 2. 設定並啟動 Web UI

`ui/web` 是同一個 pnpm workspace 的成員，`pnpm install`（repo 根目錄那次）已經連它的
依賴都裝好了，不用再裝一次。

```bash
cd ~/projects/e-mobility-charging-stations-simulator/ui/web
cp src/assets/config-template.json public/config.json
```

`public/config.json` 要指到模擬器的 UI server（預設值就對得上，不用改）：
```json
{
  "skin": "modern",
  "theme": "tokyo-night-storm",
  "uiServer": {
    "host": "localhost",
    "port": 8080,
    "protocol": "ui",
    "version": "0.0.1",
    "authentication": { "enabled": true, "type": "protocol-basic-auth", "username": "admin", "password": "admin" }
  }
}
```
**注意**：template 預設 `"skin": "classic"`，但實測 `classic` skin 在一般視窗寬度下
表格版面會壞掉（欄位重疊、文字看不清楚，是它自己的 CSS 問題）。
**建議直接改成 `"modern"`**（卡片式版面，正常好讀）。這個檔案是執行期直接
`fetch /config.json` 讀取的靜態檔，改完不用 rebuild，重新整理網頁就生效。

啟動（正式版，靜態伺服器跑在 3030 port）：
```bash
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"; nvm use 22
pnpm build
nohup node start.js > /tmp/webui.log 2>&1 & disown
# 停止: pkill -f "node start.js" （注意跟模擬器本體的 dist/start.js 分開，指令不同）
```
開發模式（有 hot-reload）可以用 `pnpm dev` 取代上面兩行。

瀏覽器打開 **http://localhost:3030**。

### 3. 怎麼用

- **右上角**：切換 skin（Classic / Modern）、切換 theme（配色）。
- **頂欄**：`Stop/Start Simulator`（整個模擬器開關）、`Add Stations`（用某個
  station template 動態加充電樁，可覆寫 base name / supervision url / 帳密等）。
- **每台充電樁一張卡片**：
  - 上半：vendor/model、OCPP 版本、registration 狀態、目前連的 CSMS URL
    （可以直接在這裡編輯改連到別的 CSMS，不用改設定檔重啟）。
  - `CONNECTORS` 區塊：每個 connector 顯示目前狀態（Charging/Available/...）、
    是否鎖定、ATG 是否在跑、進行中的 transaction（tx id、累積度數、用的 idTag）。
  - 每個 connector 可以手動：`Lock/Unlock`、`Authorize`、`Start/Stop Transaction`、
    `Start/Stop ATG`、切換錯誤碼（模擬故障）。這是**單一 connector**的開關。
  - 卡片下方：`Stop`（斷開這台充電樁）、`Disconnect`、`Delete Charging Station`、
    **`Start ATG` / `Stop ATG`**（這是**整台充電樁一次開關所有 connector**的按鈕，
    見下方「站級 ATG 開關」）。

#### 站級 ATG 開關（這次新增的功能）

原本 UI 只有「每個 connector 各自」的 Start/Stop ATG 按鈕。現在卡片下方多一個
**整台一起開關**的 `Start ATG` / `Stop ATG` 按鈕：
- 按一下 = 該充電樁**所有 connector 同時**開始/停止 ATG（後端本來就支援
  `connectorIds` 留空 = 套用到全部 connector，UI 這邊只是把它露出來）。
- 按鈕文字/狀態：只要**任一個** connector 的 ATG 在跑，就顯示 `Stop ATG`；
  全部都沒在跑才顯示 `Start ATG`。
- 兩種 skin（Classic 用 `StateButton`、Modern 用 `ActionButton`）都有加，行為一致。

改動的檔案（如果之後要照著改別的動作，可以參考這個路徑）：
- `ui/web/src/core/UIClient.ts`：`startAutomaticTransactionGenerator` /
  `stopAutomaticTransactionGenerator` 的 `connectorId` 參數改成可選——不傳就是
  對整台充電樁生效（沿用後端 `ChargingStation.ts` 本來就有的「`connectorIds`
  留空 = 全部 connector」邏輯，不用改後端）。
- `ui/web/src/shared/composables/useStationActions.ts`：新增站級的
  `startATG` / `stopATG`（跟原本 connector 級的 `useConnectorActions.ts`
  分開，命名不要搞混）。
- `ui/web/src/skins/modern/components/StationCard.vue`、
  `ui/web/src/skins/classic/components/charging-stations/CSData.vue`：
  兩個 skin 各自的卡片/列尾加上按鈕。
- 右下角會跳連線狀態的 toast，例如
  `WebSocket to UI server 'localhost:8080' successfully opened`，
  可以用這個確認瀏覽器真的有連上模擬器的 UI server（跟模擬器連不連得上 STO
  是兩件獨立的事，不要搞混）。

### 驗證方式（這次怎麼測的）

用 claude-in-chrome 開瀏覽器打開 http://localhost:3030，讀頁面文字內容
（不是只看螢幕截圖 — 截圖一度整片全黑，但用 `get_page_text` 撈 DOM 文字
發現資料其實都在，純粹是 classic skin 在該視窗寬度下的 CSS 版面問題）。
確認畫面上的 `CS-SIEMENS` / `WS OPEN` / `Accepted` / connector 的 tx 編號與度數，
跟同時間模擬器 log、STO DB 查出來的資料一致，三邊對得起來才算真的驗證過。

站級 ATG 開關功能改完後也是這樣測的：`pnpm typecheck` + `pnpm lint` 先過，
`rm dist/assets/configurations/*.json` 清掉舊的持久化設定（不然殘留的
`enable: true` 會蓋掉 template 改回的 `false`），`ctl.sh stop && ctl.sh start`
重啟後先確認 log 沒有自動跑 ATG，再到瀏覽器點卡片下方的 `Start ATG`，
確認兩個 connector 同時變成 `ATG RUNNING` 且按鈕變成 `Stop ATG`；
再點一次確認兩個都停、按鈕變回 `Start ATG`，跳出 `ATG stopped` 的 toast。

## 測試 / 驗證方式

### 1. 連線是否成功（看模擬器 log）
```bash
tail -f /tmp/simulator.log
```
關鍵字：
- `ChargingStation.onOpen: Connection to OCPP server ... succeeded`
- `OCPP16ResponseService.handleResponseBootNotification: Charging station in 'Accepted' state`

### 2. 從 STO 這邊反查（不要只信模擬器自己講的話）
```bash
docker exec ocpp16_srv_db mysql -u steve -p'<DB_PASSWORD>' stevedb \
  -e "SELECT charge_box_id, charge_point_vendor, charge_point_model, last_heartbeat_timestamp FROM charge_box WHERE charge_box_id='CS-SIEMENS';"
```
有 vendor/model 資料 + 有更新的 heartbeat 時間戳 = 雙邊都確認連線成功。

### 3. 驗證自動充電交易（ATG）
啟用 ATG 後，log 會依序出現（每個 connector 各跑一輪）：
```
ATG on connector #N: ... startTransaction: Start transaction with an idTag 'stoIdtag202604j'
OCPP16ResponseService.handleResponseStartTransaction: Transaction with id X STARTED ...
ATG on connector #N: ... stopTransaction: Stop transaction with id X
OCPP16ResponseService.handleResponseStopTransaction: Transaction with id X STOPPED ... status 'Accepted'
```

同樣要去 STO DB 反查交易紀錄與電表資料，比對模擬器 log 講的是否一致：
```bash
docker exec ocpp16_srv_db mysql -u steve -p'<DB_PASSWORD>' stevedb \
  -e "SELECT transaction_pk, connector_pk, id_tag, start_timestamp, start_value, stop_timestamp, stop_value, stop_reason FROM transaction;"

docker exec ocpp16_srv_db mysql -u steve -p'<DB_PASSWORD>' stevedb \
  -e "SELECT transaction_pk, value, reading_context, measurand, unit FROM connector_meter_value;"
```
預期：每筆交易都有 `start_value` → `stop_value`（度數遞增），
`stop_reason` 是 `Local`，中間有對應的 `Sample.Periodic` /
`Energy.Active.Import.Register` 電表資料。

實測結果範例（2026-07-22 12:25 這輪）：

| Tx ID | Connector | Start→Stop | 度數 | 結果 |
|---|---|---|---|---|
| 1 | #2 | 12:25:39→12:26:40 | 0→104 Wh | Accepted |
| 2 | #1 | 12:25:41→12:26:47 | 0→34 Wh | Accepted |

### 4. hiev backend 觸發的充電（Authorize → 自動 RemoteStartTransaction）：idTag 不等於實際卡號

跟上面第 3 節「ATG 自動交易」是不同機制：hiev backend 驅動的充電（透過 Web UI 站級
`Authorize` 按鈕輸入 rfid，backend 自動發 `RemoteStartTransaction`，見
`sto-hiev-rfid-test` skill）不能只看 STO OCPP log 的 `idTag` 欄位來確認是哪張卡在充電。

實測發現（2026-07-25，測試剛綁定的卡 `0725b`，綁定流程見 `app-bind-rfid` skill）：
`Authorize` 送出時 `idTag:"0725b"`，STO 回 Accepted 正常；但緊接著 STO 送出的
`RemoteStartTransaction`/`StartTransaction` 卻帶著另一個完全不同、STO 內建的 idTag
（`stoIdtag202607a`，`idtags.json` 裡的其中一個值）——**這不是 bug**，這個欄位只是
hiev backend 拿來讓 STO 實際觸發 OCPP 指令用的「master tag」，不代表真正在充電的會員身份。

真正的身份要看 **STO-HiEV Edge Logs Viewer**（`http://127.0.0.1:3013/`）的業務層記錄：
`RET_rfid_auth` action 跟每個 connector 狀態物件裡的 `rfid` 欄位，這兩處全程正確顯示
`0725b`。以後驗證「這次充電是哪張卡」時，一律以業務層記錄為準，不要以 OCPP 原始
`idTag` 欄位為準。

### 5. APP 直接啟動充電（無 RFID）：跟第 4 節是不同的第二種觸發路徑

HiEV APP 首頁下方「掃碼啟動充電」→ 手動輸入編號 → 模擬器把對應 connector 切到
`Preparing` → APP 自動跳出「選擇充電策略」畫面 → APP 按「開始充電」，全程不需要
RFID 卡（見 `sto-hiev-app_charge-test` skill）。實測 2026-07-26（tx 81，`106010101`，
0.47 度）：STO log 一樣是 `RemoteStartTransaction`/`StartTransaction` 帶著
`stoIdtag202607a` 這個 master tag（跟第 4 節一樣，不是真正身份）；但業務層的
per-connector 狀態物件這次顯示 **`charge_type: 'APP_CHARGING'`、`rfid: 'NA'`**——
這就是分辨「APP 直接啟動」vs「RFID 感應觸發」（`charge_type: 'AUTH_CHARGING'` +
實際 `rfid`）兩種 session 的方法。

### 6. 模擬測試時，還有兩個更詳細的 log 來源

除了模擬器自己的 log、STO 的 `steve.log`、和業務層的 Edge Logs Viewer 之外：

- **`sto_charger_local` 容器自己的 stdout**：
  ```bash
  docker logs -f --tail 100 sto_charger_local
  ```
  跟 `ocpp16_srv_app`（`docker logs` 只有 Maven build log，見上面「啟動/停止」章節）
  **相反**——`sto_charger_local` 的 `docker logs` 真的會顯示即時的業務層執行細節：
  API 進出點（`Entering/Exiting api/rx/...`）、原始 `MSG_from_AWS` 封包、connector
  心跳輪詢等，比 Edge Logs Viewer 已經解析過的事件更底層。兩個容器的 log 行為不對稱，
  別假設一樣。
- **STO 自己的網頁版 log 檢視器**：`http://127.0.0.1:3080/sto/manager/log`
  （登入 `sto`/`<WEB_PASSWORD>`）——瀏覽器版的即時 `steve.log`，內容跟
  `docker exec ocpp16_srv_app tail -f /root/logs/steve.log` 一樣，不想開 terminal
  時可以直接用瀏覽器看。

### 7. RFID 授權路徑：測試時最容易踩的三個坑

2026-07-24 站台 81401 的「無 TASK_ID 卻持續充電 17 分鐘」事件（tx 751）調查時確立的
結構性事實，測試 RFID 相關行為前務必先知道。

#### (a) `/api/rx/ocpp16j_AUTH` 不是只有刷卡才會打

STO 的 `CentralSystemService16_Service` 有**三個** handler 會呼叫
`ocppTagService.getIdTagInfo()`──`startTransaction()`、`stopTransaction()`、`authorize()`，
三者最後都走到 `decideStatus()` → `postToLocalSrv_AUTH()`。而該方法把 `_action` **寫死**成
`"Authorize"`，也沒有把 `isStartTransactionReqContext` 傳下去，所以地端根本無法分辨
「車主真的刷卡」與「交易訊息附帶的 idTag 檢核」。

判斷方式：`steve.log` 裡若 `OcppTagService ... posted data` 之前**沒有**對應的
`Received: [...,"Authorize",...]`，那就是交易訊息觸發的，不是刷卡。

`stopTransaction()` 已於 ocpp_srv `970b647` 修正（不再檢核、`StopTransaction.conf` 也不再
帶 `idTagInfo`）。**`startTransaction()` 仍維持原樣**——RFID 充電的雲端任務其實是由那次
AUTH 觸發建立的，動它要連任務建立流程一起重新設計。

#### (b) 兩個捷徑會讓 bug 在模擬環境「測不出來」

`OcppTagService.decideStatus()` 裡有兩個提早返回：
- `idTag.startsWith("stoIdtag")` → 直接 `ACCEPTED`，**完全不打地端**
- `recentAcceptedTags` 快取（`expireAfterWrite(3, SECONDS)`）→ 同一 idTag 3 秒內重複檢核
  直接從快取回 `ACCEPTED`，不問地端也不問雲端

**這是模擬環境的最大盲點**：由 hiev backend 的 `RemoteStartTransaction` 驅動的充電，交易
帶的是 master tag `stoIdtag202607a`，其 Start/StopTransaction 全部命中捷徑，永遠不會打到
地端。要重現這條路徑上的任何問題，必須讓**交易本身**帶真實 RFID：

```bash
# 用 UI WebSocket 的 startTransaction 指定 idTag（模擬 Phihong 刷卡後自行啟動）
# 見 app-bind-rfid skill 的 authorize-rfid.mjs，同樣的連線方式改呼叫 startTransaction
```

注意副作用：手動用真實 RFID 啟動交易，會讓地端誤判為刷卡而在約 4 秒後**再發一次**
`RemoteStartTransaction`，在 STO DB 留下一筆孤兒 open transaction。不想要的話 2 秒內停掉。

#### (c) 地端的 `AUTH` 是 per-station 單例

`global.CSMS.CHARGERS[cpCode]['AUTH']` 沒有 per-request 隔離。同站台 4 秒內的兩個 AUTH
請求會互相覆寫 `status`/`rfid`/`timestamp`。任何在 `await`／timer tick 之後讀它的邏輯，
都必須重新確認它描述的還是自己那張卡。

#### 除錯小技巧

- **morgan 印出 `POST /api/rx/ocpp16j_AUTH  -  - ms  -  -`**（全是破折號）代表 handler
  **從未送出回應**。正常長這樣：`200 405.608 ms - 8`。這是發現請求 hang 住最快的方法。
- `postToLocalSrv_AUTH` 的 timeout 是 `Duration.ofSeconds(10)`。若某筆請求剛好花 ~10 秒
  且結果是 `response: Unknown` + `INVALID`，那是地端 hang 住，不是卡片被拒絕。
- `steve.log` 裡的 Java stack trace 會直接指出呼叫鏈
  （`postToLocalSrv_AUTH ← decideStatus ← getIdTagInfo`），是確認「哪個 OCPP handler
  觸發了 AUTH」最快的證據。

#### (d) 【TODO】地端 60 秒授權窗口與 CP 韌體過期時間尚未對齊

地端 `set_CSMS_CHARGERS_State()` 的 `iTHD_RFID_plug_time = 60`：刷卡被接受後若超過 60 秒才
插槍，地端會記 `RFID timeout` 並丟棄該次授權、**不建雲端任務**，但**不會通知 CP**。

CP 韌體本身也有授權過期時間，據回報約在 **45~90 秒**區間（尚未精確量測）。兩者不一致時，
落在中間的插槍就會產生「CP 開始充電但地端已寫掉、沒有 TASK_ID」的狀況。

**待辦（2026-07-26 記錄）**：實機量測 Phihong CP 的實際過期時間 —— 刷卡後等 N 秒再插槍，
二分搜尋出 CP 不再自行啟動的臨界 N，再決定 `iTHD_RFID_plug_time` 要對齊到哪個值。
兩邊對齊才是真正的解法；`charge_stop if no TaskID_from_aws` 只是兜底。

#### (e) TASK_ID 只用於歸檔計費，不是啟動充電的必要條件

地端一旦回 `ACCEPT`，CP 就進入準充電狀態，之後只要插槍就會開始充電，**不需要**後續的
`RET_ocpp_charge_s`。所以「有充電但無 TASK_ID」是**計費**問題不是控制問題——這也是為什麼
地端需要 `charge_stop if no TaskID_from_aws` 這個保護機制主動把這類充電停掉。

### 監看小技巧
用背景 `tail -F | grep` 過濾關鍵字即時看事件，比一直手動 tail 方便：
```bash
tail -n0 -F /tmp/simulator.log | grep -E --line-buffered \
  "Authorize|StartTransaction|StopTransaction|MeterValues|error|Error|ATG on connector"
```

## 重建環境的最短步驟摘要

1. `nvm install 22 && nvm use 22`
2. `corepack enable && corepack prepare pnpm@latest --activate`
3. `git clone https://github.com/SAP/e-mobility-charging-stations-simulator.git`
4. `pnpm install`
5. copy `config-template.json` → `config.json`，改 `supervisionUrls` 指向 STO
6. copy `idtags-template.json` → `idtags.json`，換成 STO 已註冊的 idTag
7. 挑一個 station template（如 siemens），確認 `fixedName`/`baseName` 決定的
   chargingStationId，去 STO DB `INSERT INTO charge_box (charge_box_id, ...)`
8. `AutomaticTransactionGenerator.enable` 維持 template 預設的 `false`；
   需要跑自動交易時改用 Web UI 卡片上的 `Start ATG` 按鈕開，**不要改這個檔案**
   （改成 `true` 會導致每次 `ctl.sh` 重啟都自動開始跑 ATG，之前踩過這雷）
9. **改過 template 之後記得清掉 `dist/assets/configurations/*.json` 舊的持久化設定**
10. （選用）要圖形化介面才做：`config.json` 開 `uiServer.enabled: true` →
    `ui/web` copy `config.json`（skin 改 `modern`）
11. `./ctl.sh start`（一次把模擬器 + Web UI 都建置並啟動；沒有 Web UI 需求
    也沒差，`ctl.sh` 兩個都會啟動）
12. 用上面「測試 / 驗證方式」章節的 log 關鍵字 + STO DB 查詢做雙邊確認，
    或直接開 http://localhost:3030 看
13. 不用的時候 `./ctl.sh stop`
