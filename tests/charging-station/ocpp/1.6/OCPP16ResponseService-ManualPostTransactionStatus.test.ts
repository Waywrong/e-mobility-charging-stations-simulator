/**
 * @file Tests for OCPP16ResponseService manualPostTransactionStatus
 * @description Verifies that the automatic release to Available at transaction stop is
 * suppressed in OCPP 1.6 StopTransaction response handling: the connector is held in
 * Finishing with and without postTransactionDelay, a scheduled Inoperative availability
 * change still takes effect, and the transaction state is cleaned up either way.
 */

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'

import type { ChargingStation } from '../../../../src/charging-station/index.js'
import type { OCPP16ResponseService } from '../../../../src/charging-station/ocpp/1.6/OCPP16ResponseService.js'
import type {
  OCPP16StopTransactionRequest,
  OCPP16StopTransactionResponse,
} from '../../../../src/types/index.js'

import { OCPP16ServiceUtils } from '../../../../src/charging-station/ocpp/1.6/OCPP16ServiceUtils.js'
import {
  AvailabilityType,
  OCPP16AuthorizationStatus,
  OCPP16ChargePointStatus,
  OCPP16RequestCommand,
} from '../../../../src/types/index.js'
import {
  flushMicrotasks,
  setupConnectorWithTransaction,
  standardCleanup,
  withMockTimers,
} from '../../../helpers/TestLifecycleHelpers.js'
import { createOCPP16ResponseTestContext, setMockRequestHandler } from './OCPP16TestUtils.js'

const acceptedResponse: OCPP16StopTransactionResponse = {
  idTagInfo: { status: OCPP16AuthorizationStatus.ACCEPTED },
}

await describe('OCPP16ResponseService — ManualPostTransactionStatus', async () => {
  let station: ChargingStation
  let responseService: OCPP16ResponseService
  let requestCalls: unknown[][]

  const stopTransactionRequest = (transactionId: number): OCPP16StopTransactionRequest => ({
    meterStop: 1000,
    timestamp: new Date(),
    transactionId,
  })

  const statusCallsOnConnector1 = (): string[] =>
    requestCalls
      .filter(
        call =>
          call[1] === OCPP16RequestCommand.STATUS_NOTIFICATION &&
          (call[2] as Record<string, unknown>).connectorId === 1
      )
      .map(call => (call[2] as Record<string, unknown>).status as string)

  beforeEach(() => {
    const ctx = createOCPP16ResponseTestContext({
      stationInfo: { manualPostTransactionStatus: true, postTransactionDelay: 0 },
    })
    station = ctx.station
    responseService = ctx.responseService
    station.started = true

    requestCalls = []
    setMockRequestHandler(station, (...args: unknown[]) => {
      requestCalls.push(args)
      return Promise.resolve({})
    })

    mock.method(OCPP16ServiceUtils, 'startUpdatedMeterValues', () => {
      /* noop */
    })
    mock.method(OCPP16ServiceUtils, 'stopUpdatedMeterValues', () => {
      /* noop */
    })
  })

  afterEach(() => {
    standardCleanup()
  })

  await it('should hold the connector in Finishing instead of releasing it to Available', async () => {
    // Arrange
    setupConnectorWithTransaction(station, 1, { transactionId: 100 })
    const connectorStatus = station.getConnectorStatus(1)
    if (connectorStatus == null) {
      assert.fail('Expected connector 1 to exist')
    }
    connectorStatus.status = OCPP16ChargePointStatus.Charging

    // Act
    await responseService.responseHandler(
      station,
      OCPP16RequestCommand.STOP_TRANSACTION,
      acceptedResponse,
      stopTransactionRequest(100)
    )

    // Assert
    assert.deepStrictEqual(statusCallsOnConnector1(), [OCPP16ChargePointStatus.Finishing])
    assert.strictEqual(connectorStatus.status, OCPP16ChargePointStatus.Finishing)
    assert.strictEqual(connectorStatus.transactionStarted, false)
    assert.strictEqual(connectorStatus.transactionId, undefined)
  })

  await it('should not release to Available after the postTransactionDelay elapses', async t => {
    // Arrange
    assert.ok(station.stationInfo != null, 'stationInfo should be defined')
    station.stationInfo.postTransactionDelay = 5
    setupConnectorWithTransaction(station, 1, { transactionId: 200 })
    const connectorStatus = station.getConnectorStatus(1)
    if (connectorStatus == null) {
      assert.fail('Expected connector 1 to exist')
    }
    connectorStatus.status = OCPP16ChargePointStatus.Charging

    // Act
    await withMockTimers(t, ['setTimeout'], async () => {
      const promise = responseService.responseHandler(
        station,
        OCPP16RequestCommand.STOP_TRANSACTION,
        acceptedResponse,
        stopTransactionRequest(200)
      )
      for (let i = 0; i < 10; i++) {
        await flushMicrotasks()
      }
      t.mock.timers.tick(5000)
      for (let i = 0; i < 10; i++) {
        await flushMicrotasks()
      }
      await promise
    })

    // Assert: Finishing is sent once before the sleep and not repeated afterwards
    assert.deepStrictEqual(statusCallsOnConnector1(), [OCPP16ChargePointStatus.Finishing])
    assert.strictEqual(connectorStatus.status, OCPP16ChargePointStatus.Finishing)
    assert.strictEqual(connectorStatus.transactionStarted, false)
  })

  await it('should still send Unavailable when the station is inoperative', async () => {
    // Arrange
    setupConnectorWithTransaction(station, 1, { transactionId: 300 })
    const connectorStatus = station.getConnectorStatus(1)
    if (connectorStatus == null) {
      assert.fail('Expected connector 1 to exist')
    }
    connectorStatus.status = OCPP16ChargePointStatus.Charging
    const connector0 = station.getConnectorStatus(0)
    if (connector0 == null) {
      assert.fail('Expected connector 0 to exist')
    }
    connector0.availability = AvailabilityType.Inoperative

    // Act
    await responseService.responseHandler(
      station,
      OCPP16RequestCommand.STOP_TRANSACTION,
      acceptedResponse,
      stopTransactionRequest(300)
    )

    // Assert
    assert.deepStrictEqual(statusCallsOnConnector1(), [OCPP16ChargePointStatus.Unavailable])
    assert.strictEqual(connectorStatus.status, OCPP16ChargePointStatus.Unavailable)
  })

  await it('should release to Available when the tunable is disabled', async () => {
    // Arrange
    assert.ok(station.stationInfo != null, 'stationInfo should be defined')
    station.stationInfo.manualPostTransactionStatus = false
    setupConnectorWithTransaction(station, 1, { transactionId: 400 })
    const connectorStatus = station.getConnectorStatus(1)
    if (connectorStatus == null) {
      assert.fail('Expected connector 1 to exist')
    }
    connectorStatus.status = OCPP16ChargePointStatus.Charging

    // Act
    await responseService.responseHandler(
      station,
      OCPP16RequestCommand.STOP_TRANSACTION,
      acceptedResponse,
      stopTransactionRequest(400)
    )

    // Assert
    assert.deepStrictEqual(statusCallsOnConnector1(), [OCPP16ChargePointStatus.Available])
    assert.strictEqual(connectorStatus.status, OCPP16ChargePointStatus.Available)
  })
})
