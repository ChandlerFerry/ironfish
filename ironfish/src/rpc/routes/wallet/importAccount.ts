/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { v4 as uuid } from 'uuid'
import * as yup from 'yup'
import { AccountImport } from '../../../wallet/walletdb/accountValue'
import { ApiNamespace, router } from '../router'

export type ImportAccountRequest = {
  account: AccountImport
  passphrase?: string
  rescan?: boolean
}

export type ImportResponse = {
  name: string
  isDefaultAccount: boolean
}

export const ImportAccountRequestSchema: yup.ObjectSchema<ImportAccountRequest> = yup
  .object({
    passphrase: yup.string().optional(),
    rescan: yup.boolean().optional().default(true),
    account: yup
      .object({
        name: yup.string().defined(),
        spendingKey: yup.string().nullable().defined(),
        viewKey: yup.string().defined(),
        publicAddress: yup.string().defined(),
        incomingViewKey: yup.string().defined(),
        outgoingViewKey: yup.string().defined(),
        version: yup.number().defined(),
        createdAt: yup
          .object({
            hash: yup.string().defined(),
            sequence: yup.number().defined(),
          })
          .nullable()
          .defined(),
      })
      .defined(),
  })
  .defined()

export const ImportAccountResponseSchema: yup.ObjectSchema<ImportResponse> = yup
  .object({
    name: yup.string().defined(),
    isDefaultAccount: yup.boolean().defined(),
  })
  .defined()

router.register<typeof ImportAccountRequestSchema, ImportResponse>(
  `${ApiNamespace.wallet}/importAccount`,
  ImportAccountRequestSchema,
  async (request, node): Promise<void> => {
    let createdAt = null
    if (request.data.account.createdAt) {
      createdAt = {
        hash: Buffer.from(request.data.account.createdAt.hash, 'hex'),
        sequence: request.data.account.createdAt.sequence,
      }
    }

    const accountValue = {
      id: uuid(),
      ...request.data.account,
      createdAt,
    }
    // TODO: should passphrase go in the accountValue?
    const account = await node.wallet.importAccount(accountValue, request.data.passphrase)

    if (request.data.rescan) {
      void node.wallet.scanTransactions()
    } else {
      await node.wallet.skipRescan(account)
    }

    let isDefaultAccount = false
    if (!node.wallet.hasDefaultAccount) {
      await node.wallet.setDefaultAccount(account.name)
      isDefaultAccount = true
    }

    request.end({
      name: account.name,
      isDefaultAccount,
    })
  },
)
