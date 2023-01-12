/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { CurrencyUtils, isValidPublicAddress, Transaction, RawTransactionSerde } from '@ironfish/sdk'
//import { RawTransactionSerde } from '@ironfish/sdk/src/primitives/rawTransaction'
import { CliUx, Flags } from '@oclif/core'
import { IronfishCommand } from '../../command'
import { RemoteFlags } from '../../flags'
import { ProgressBar } from '../../types'

export class Send extends IronfishCommand {
  static description = `Send coins to another account`

  static examples = [
    '$ ironfish accounts:send -a 2 -o 0.00000001 -t 997c586852d1b12da499bcff53595ba37d04e4909dbdb1a75f3bfd90dd7212217a1c2c0da652d187fc52ed',
    '$ ironfish accounts:send -a 2 -o 0.00000001 -t 997c586852d1b12da499bcff53595ba37d04e4909dbdb1a75f3bfd90dd7212217a1c2c0da652d187fc52ed -f otheraccount',
    '$ ironfish accounts:send -a 2 -o 0.00000001 -t 997c586852d1b12da499bcff53595ba37d04e4909dbdb1a75f3bfd90dd7212217a1c2c0da652d187fc52ed -f otheraccount -m my_message_for_the_transaction',
  ]

  static flags = {
    ...RemoteFlags,
    account: Flags.string({
      char: 'f',
      description: 'The account to send money from',
    }),
    amount: Flags.string({
      char: 'a',
      description: 'Amount of coins to send in IRON',
    }),
    to: Flags.string({
      char: 't',
      description: 'The public address of the recipient',
    }),
    fee: Flags.string({
      char: 'o',
      description: 'The fee amount in IRON',
    }),
    memo: Flags.string({
      char: 'm',
      description: 'The memo of transaction',
    }),
    confirm: Flags.boolean({
      default: false,
      description: 'Confirm without asking',
    }),
    expiration: Flags.integer({
      char: 'e',
      description:
        'The block sequence after which the transaction will be removed from the mempool. Set to 0 for no expiration.',
    }),
    priority: Flags.string({
      default: 'medium',
      char: 'p',
      description: 'The priority level for transaction fee estimation.',
      options: ['low', 'medium', 'high'],
    }),
    assetId: Flags.string({
      char: 'i',
      description: 'The identifier for the asset to use when sending',
    }),
  }

  async start(): Promise<void> {
    const { flags } = await this.parse(Send)
    let amount = null
    let fee = null
    let to = flags.to?.trim()
    let from = flags.account?.trim()
    const expiration = flags.expiration
    const memo = flags.memo || ''

    const client = await this.sdk.connectRpc(false, true)

    const status = await client.getNodeStatus()
    if (!status.content.blockchain.synced) {
      this.log(
        `Your node must be synced with the Iron Fish network to send a transaction. Please try again later`,
      )
      this.exit(1)
    }

    if (flags.amount) {
      amount = CurrencyUtils.decodeIron(flags.amount)
    }

    const assetId = flags.assetId

    if (amount === null) {
      const response = await client.getAccountBalance({ account: from, assetId })

      const input = await CliUx.ux.prompt(
        `Enter the amount (balance: ${CurrencyUtils.renderIron(response.content.confirmed)})`,
        {
          required: true,
        },
      )

      amount = CurrencyUtils.decodeIron(input)
    }

    if (flags.fee) {
      fee = CurrencyUtils.decodeIron(flags.fee)

      if (fee < 1n) {
        this.error(`The minimum fee is ${CurrencyUtils.renderOre(1n, true)}`)
      }
    }

    if (!from) {
      const response = await client.getDefaultAccount()
      const defaultAccount = response.content.account

      if (!defaultAccount) {
        this.error(
          `No account is currently active.
           Use ironfish accounts:create <name> to first create an account`,
        )
      }

      from = defaultAccount.name
    }

    if (!to) {
      to = await CliUx.ux.prompt('Enter the the public address of the recipient', {
        required: true,
      })

      if (!isValidPublicAddress(to)) {
        this.error(`A valid public address is required`)
      }
    }

    if (!isValidPublicAddress(to)) {
      this.log(`A valid public address is required`)
      this.exit(1)
    }

    if (expiration !== undefined && expiration < 0) {
      this.log('Expiration sequence must be non-negative')
      this.exit(1)
    }

    const createResponse = await client.createTransaction({
      fromAccountName: from,
      receives: [
        {
          publicAddress: to,
          amount: CurrencyUtils.encode(amount),
          memo,
          assetId,
        },
      ],
      fee: flags.fee,
      feePriorityLevel: flags.priority,
      expiration: expiration,
    })

    const rawTransactionBytes = Buffer.from(createResponse.content.transaction, 'hex')
    const rawTransaction = RawTransactionSerde.deserialize(rawTransactionBytes)

    if (!flags.confirm) {
      this.log(`
You are about to send:
${CurrencyUtils.renderIron(
  rawTransaction.spends[0].note.value(),
  true,
  assetId,
)} plus a transaction fee of ${CurrencyUtils.renderIron(
        rawTransaction.fee,
        true,
      )} to ${to} from the account ${from}

* This action is NOT reversible *
`)

      const confirm = await CliUx.ux.confirm('Do you confirm (Y/N)?')
      if (!confirm) {
        this.log('Transaction aborted.')
        this.exit(0)
      }
    }

    // Run the progress bar for about 2 minutes
    // Chances are that the transaction will finish faster (error or faster computer)
    const bar = CliUx.ux.progress({
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      format: 'Creating the transaction: [{bar}] {percentage}% | ETA: {eta}s',
    }) as ProgressBar

    bar.start()

    let value = 0
    const timer = setInterval(() => {
      value++
      bar.update(value)
      if (value >= bar.getTotal()) {
        bar.stop()
      }
    }, 1000)

    const stopProgressBar = () => {
      clearInterval(timer)
      bar.update(100)
      bar.stop()
    }

    try {
      const result = await client.postTransaction({
        transaction: createResponse.content.transaction
      })

      stopProgressBar()

      const transactionBytes = Buffer.from(result.content.transaction, 'hex')
      const transaction = new Transaction(transactionBytes)

      this.log(`
Sending ${CurrencyUtils.renderIron(amount, true, assetId)} to ${to} from ${
        from
      }
Transaction Hash: ${transaction.hash}
Transaction fee: ${CurrencyUtils.renderIron(transaction.fee(), true)}

Find the transaction on https://explorer.ironfish.network/transaction/${
        transaction.hash
      } (it can take a few minutes before the transaction appears in the Explorer)`)
    } catch (error: unknown) {
      stopProgressBar()
      this.log(`An error occurred while sending the transaction.`)
      if (error instanceof Error) {
        this.error(error.message)
      }
      this.exit(2)
    }
  }
}
