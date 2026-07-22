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
   docker exec ocpp16_srv_db mysql -u steve -pstohiev stevedb \
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
     docker exec ocpp16_srv_db mysql -u steve -pstohiev stevedb \
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

## STO 端：註冊 charge box

STO 預設**不會**自動接受未註冊的 chargeBoxId，必須先在 `charge_box` table
建一筆（這跟 STO 網頁的「Add Charge Point」功能本質上是同一個 INSERT，
對照原始碼 `ChargePointRepositoryImpl.addChargePointList()` 只需要
`charge_box_id` 這個欄位）：

```bash
docker exec ocpp16_srv_db mysql -u steve -pstohiev stevedb \
  -e "INSERT INTO charge_box (charge_box_id, insert_connector_status_after_transaction_msg) VALUES ('CS-SIEMENS', 0);"
```

DB 連線資訊（來自 `docker inspect ocpp16_srv_db` 的環境變數）：
- DB 名稱: `stevedb`　user: `steve`　password: `stohiev`

確認已註冊：
```bash
docker exec ocpp16_srv_db mysql -u steve -pstohiev stevedb \
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
docker exec ocpp16_srv_db mysql -u steve -pstohiev stevedb \
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
docker exec ocpp16_srv_db mysql -u steve -pstohiev stevedb \
  -e "SELECT transaction_pk, connector_pk, id_tag, start_timestamp, start_value, stop_timestamp, stop_value, stop_reason FROM transaction;"

docker exec ocpp16_srv_db mysql -u steve -pstohiev stevedb \
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
