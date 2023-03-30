/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import {
  Config,
  ConfigOptions,
  createRootLogger,
  Event,
  FollowChainStreamResponse,
  Logger,
  NodeFileProvider,
  PromiseUtils,
  RpcTcpClient,
  YupUtils,
} from '@ironfish/sdk'
import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import {
  defaultOnError,
  defaultOnExit,
  ErrorEvent,
  ExitEvent,
  LogEvent,
  NodeLogEventSchema,
  supportedNodeChildProcesses,
} from './events'
import { sleep } from './misc'
import { getLatestBlockHash } from './utils/chain'

export const rootCmd = 'ironfish'

/**
 * SimulationNodeConfig is the configuration for a node in the simulation network.
 * All the `RequiredSimulationNodeConfig` options are required to start a node but defaults will be set
 * if they are not provided. The rest of the `ConfigOptions` are optional and will be used to override
 * the defaults.
 */
export type SimulationNodeConfig = Required<RequiredSimulationNodeConfig> &
  Partial<Omit<ConfigOptions, keyof RequiredSimulationNodeConfig>> & {
    dataDir: string
    verbose?: boolean
  }

/**
 * These options are required to start a node.
 */
export type RequiredSimulationNodeConfig = Pick<
  ConfigOptions,
  | 'nodeName'
  | 'blockGraffiti'
  | 'peerPort'
  | 'networkId'
  | 'rpcTcpHost'
  | 'rpcTcpPort'
  | 'bootstrapNodes'
>

/**
 * Global logger for use in the simulator node.
 */
const globalLogger = createRootLogger()

/**
 * SimulationNode is a wrapper around an Ironfish node for use in the simulation network.
 *
 * This class is responsible for the node, the miner, and
 * providing a client to interact with the node.
 *
 * The node itself can be accessed via another terminal by specifying it's
 * `data_dir` while it is running.
 *
 * This class should be constructed using the static `intiailize()` method.
 */
export class SimulationNode {
  procs = new Map<string, ChildProcessWithoutNullStreams>()
  nodeProcess: ChildProcessWithoutNullStreams
  minerProcess?: ChildProcessWithoutNullStreams

  onBlock: Event<[FollowChainStreamResponse]> = new Event()

  /**
   * The last error encountered by the node. This is useful for debugging
   * when a node crashes or exits unexpectedly.
   */
  lastError: Error | undefined

  /**
   * @event Emitted when the node logs a message
   */
  onLog: Event<[LogEvent]> = new Event()
  onError: Event<[ErrorEvent]> = new Event()
  onExit: Event<[ExitEvent]> = new Event()

  /** The client used to make RPC calls against the underlying Ironfish node */
  client: RpcTcpClient
  config: SimulationNodeConfig

  /** Promise that resolves when the node shuts down */
  private shutdownPromise: Promise<void>

  /** Call to resolve the shutdown promise */
  private shutdownResolve: () => void

  logger: Logger

  /** If the node is ready to be interacted with */
  ready = false
  /** If the node was stopped */
  stopped = false

  /**
   * Use the `initialize()` method to construct a SimulationNode.
   */
  private constructor(
    config: SimulationNodeConfig,
    client: RpcTcpClient,
    logger: Logger,
    options?: {
      onLog?: ((l: LogEvent) => void | Promise<void>)[]
      onExit?: ((e: ExitEvent) => void | Promise<void>)[]
      onError?: ((e: ErrorEvent) => void | Promise<void>)[]
    },
  ) {
    this.config = config
    this.client = client
    this.logger = logger.withTag(`${config.nodeName}`)

    // Data dir is required here
    const args = ['start', '--datadir', this.config.dataDir]

    // Register any user-provided event handlers
    if (options?.onLog) {
      options.onLog.forEach((e) => this.onLog.on(e))
    }
    if (options?.onExit) {
      options.onExit.forEach((e) => this.onExit.on(e))
    }
    if (options?.onError) {
      options.onError.forEach((e) => this.onError.on(e))
    }

    this.nodeProcess = this.startNodeProcess(args)

    // TODO(holahula): hack to clean up when the node process exits
    this.onExit.on((exit) => {
      if (exit.proc === 'node') {
        if (this.shutdownResolve) {
          this.shutdownResolve()
          this.stopped = true
        }
        this.cleanup()
      }
    })

    const [shutdownPromise, shutdownResolve] = PromiseUtils.split<void>()
    this.shutdownPromise = shutdownPromise
    this.shutdownResolve = shutdownResolve

    this.logger.log(`started node: ${this.config.nodeName}`)
  }

  /**
   * Initializes a new SimulationNode. This should be used instead of the constructor
   * to ensure that the node is ready to be used. Upon return, the node will be ready
   * for any client RPC calls.
   *
   * @param config the config for the node
   * @param logger the logger to use for the node
   * @param options event handlers to handle events from child processes. If not provided, default handlers will be used.
   *
   * @returns A new and ready SimulationNode
   */
  static async init(
    config: SimulationNodeConfig,
    logger: Logger,
    options?: {
      onLog?: ((l: LogEvent) => void | Promise<void>)[]
      onExit?: ((e: ExitEvent) => void | Promise<void>)[]
      onError?: ((c: ErrorEvent) => void | Promise<void>)[]
    },
  ): Promise<SimulationNode> {
    const client = new RpcTcpClient(config.rpcTcpHost, config.rpcTcpPort)

    if (options) {
      options.onExit = options.onExit || [defaultOnExit(logger)]
      options.onError = options.onError || [defaultOnError(logger)]
    }

    // Create a starting config in the datadir before starting the node
    const fileSystem = new NodeFileProvider()
    await fileSystem.init()
    const nodeConfig = new Config(fileSystem, config.dataDir)
    await nodeConfig.load()

    if (config.verbose) {
      nodeConfig.set('logLevel', '*:verbose')
    }

    for (const [key, value] of Object.entries(config)) {
      // TODO(holahula): this is a hack to get around the fact that the config
      // has `dataDir` / `verbose properties that is not a valid config option
      if (key === 'dataDir' || key === 'verbose') {
        continue
      }
      nodeConfig.set(key as keyof ConfigOptions, value)
    }

    // These config options have specific values that must be set
    // and thus are not configurable
    nodeConfig.set('jsonLogs', true)
    nodeConfig.set('enableRpc', true)
    nodeConfig.set('enableRpcTcp', true)
    nodeConfig.set('enableRpcTls', false)
    nodeConfig.set('miningForce', true)

    await nodeConfig.save()

    const node = new SimulationNode(config, client, logger, options)

    // Contineu to attempt to connect to the node until it is ready
    let connected = false
    let tries = 0
    while (!connected && tries < 12) {
      connected = await client.tryConnect()
      tries++
      await sleep(250)
    }

    if (!connected) {
      throw new Error(`failed to connect to node ${config.nodeName}`)
    }

    node.initializeBlockStream(await getLatestBlockHash(node))

    node.ready = true

    return node
  }

  /**
   * Attaches listeners to a child process and adds the process to the node's
   * list of child processes.
   *
   * @param proc The child process to add
   * @param procName The name of the process, used for logging and accessing the proc.
   */
  private registerChildProcess(
    proc: ChildProcessWithoutNullStreams,
    procName: supportedNodeChildProcesses,
  ): void {
    this.attachListeners(proc, procName)
    this.procs.set(procName, proc)
  }

  /**
   *
   * Starts and attaches a miner process to the simulation node
   */
  public startMiner(): boolean {
    if (this.minerProcess) {
      return false
    }

    this.logger.log(`attaching miner to ${this.config.nodeName}...`)

    this.minerProcess = spawn('ironfish', [
      'miners:start',
      '-t',
      '1',
      '--datadir',
      this.config.dataDir,
    ])

    this.registerChildProcess(this.minerProcess, 'miner')

    return true
  }

  /**
   * Stops and detaches the miner process from the node. This can be called at any time during the simulation
   * if you would like to stop mining.
   *
   * @returns Whether the miner was successfully detached
   */
  public stopMiner(): boolean {
    if (!this.minerProcess) {
      throw new Error('Miner process not found')
    }

    this.logger.log(`detaching miner from ${this.config.nodeName}...`)

    const success = this.minerProcess.kill()

    this.procs.delete('miner')
    this.minerProcess = undefined

    return success
  }

  /**
   * Initializes a block stream for a node. Each node should only have 1 block stream
   * because currently the stream RPC  cannot be closed.
   *
   * To verify a transaction has been mined, you should attach a listener to the `onBlock` event
   * and wait for the transaction to appear.
   */
  initializeBlockStream(startingBlockHash: string): void {
    const blockStream = this.client
      .followChainStream({ head: startingBlockHash.toString() })
      .contentStream()

    const stream = async () => {
      for await (const block of blockStream) {
        this.onBlock.emit(block)
      }
    }

    void stream()
  }

  /**
   * Waits for a transaction to be mined and returns the block it was mined in.
   * If the transaction is not mined before the expiration sequence, it will return undefined.
   *
   * @param transactionHash The hash of the transaction to wait for
   * @returns The block the transaction was mined in or undefined if the transaction was not mined
   */
  async waitForTransactionConfirmation(
    transactionHash: string,
    expirationSequence?: number,
  ): Promise<FollowChainStreamResponse['block'] | undefined> {
    return new Promise((resolve) => {
      const checkBlock = (resp: FollowChainStreamResponse) => {
        const hasTransation = resp.block.transactions.find(
          (t) => t.hash.toLowerCase() === transactionHash,
        )

        if (
          resp.type === 'connected' &&
          expirationSequence &&
          resp.block.sequence >= expirationSequence
        ) {
          this.onBlock.off(checkBlock)
          resolve(undefined)
        }

        if (resp.type === 'connected' && hasTransation) {
          // TODO: is there a better way to remove the event listener?
          this.onBlock.off(checkBlock)
          resolve(resp.block)
        }
      }

      this.onBlock.on(checkBlock)
    })
  }

  /**
   * Starts the node process and attaches listeners to it.
   *
   * @param args The arguments to pass to the node process. These arguments follow
   * the same format as the CLI.
   *
   * @returns The node process
   */
  private startNodeProcess(args: string[]): ChildProcessWithoutNullStreams {
    const nodeProc = spawn(rootCmd, args)
    this.registerChildProcess(nodeProc, 'node')

    return nodeProc
  }

  /**
   * Utility function to wait for the node to shutdown.
   */
  async waitForShutdown(): Promise<void> {
    await this.shutdownPromise
  }

  /**
   * Stops the node process and cleans up any listeners or other child processes.
   */
  async stop(): Promise<{ success: boolean; msg: string }> {
    this.logger.log(`killing node ${this.config.nodeName}...`)

    return stopSimulationNode(this.config)
  }

  /**
   * Adds listeners to the events for a child process.
   * The events are forwarded to the on<Event> event emitters and can be subscribed to.
   *
   * @param p The process to attach listeners to
   * @param procName The name of the process, used for logging
   */
  private attachListeners(
    p: ChildProcessWithoutNullStreams,
    proc: supportedNodeChildProcesses,
  ): void {
    p.stdout.on('data', (data) => {
      const message = (data as Buffer).toString()
      void YupUtils.tryValidate(NodeLogEventSchema, message).then(({ result }) => {
        this.onLog.emit({
          node: this.config.nodeName,
          proc,
          type: 'stdout',
          message,
          timestamp: new Date().toISOString(),
          ...(result ? { jsonMessage: result } : {}),
        })
      })
    })

    p.stderr.on('data', (data) => {
      const message = (data as Buffer).toString()
      void YupUtils.tryValidate(NodeLogEventSchema, message).then(({ result }) => {
        this.onLog.emit({
          node: this.config.nodeName,
          proc,
          type: 'stderr',
          message,
          timestamp: new Date().toISOString(),
          ...(result ? { jsonMessage: result } : {}),
        })
      })
    })

    p.on('error', (error: Error) => {
      this.lastError = error

      this.onError.emit({
        node: this.config.nodeName,
        proc,
        error,
        timestamp: new Date().toISOString(),
      })
    })

    // The exit event is emitted when the child process ends.
    // The last error encountered by the process is emitted in the event that this is an unexpected exit.
    p.on('exit', (code, signal) => {
      this.onExit.emit({
        node: this.config.nodeName,
        proc,
        code,
        signal,
        lastErr: this.lastError,
        timestamp: new Date().toISOString(),
      })
    })

    return
  }

  /**
   * Kills all child processes and handles any required cleanup
   */
  private cleanup(): void {
    this.logger.log(`cleaning up ${this.config.nodeName}...`)

    this.procs.forEach((proc) => {
      // TODO: handle kill response
      const _ = proc.kill()
    })

    this.procs.clear()

    // TODO: adding onExit here removes the exit handlers before they're executed on child process exit
    // which is breaking, but ideally it should be here
    // this.onExit.clear()

    this.onBlock.clear()
    this.onLog.clear()
    this.onError.clear()
  }
}

/**
 * Public function to stop a node
 *
 * This is because you cannot access the actual SimulationNode object with the
 * running node/miner procs from other cli commands
 */
export async function stopSimulationNode(node: {
  nodeName: string
  dataDir: string
  rpcTcpHost: string
  rpcTcpPort: number
}): Promise<{ success: boolean; msg: string }> {
  const client = new RpcTcpClient(node.rpcTcpHost, node.rpcTcpPort)

  try {
    const connectSuccess = await client.tryConnect()
    if (!connectSuccess) {
      throw new Error(`failed to connect to node ${node.nodeName}`)
    }
  } catch (e) {
    globalLogger.log(`error creating client to connect to node ${node.nodeName}: ${String(e)}`)
  }

  let success = true
  let msg = ''

  try {
    await client.stopNode()
  } catch (error) {
    if (error instanceof Error) {
      msg = error.message
    } else {
      msg = String(error)
    }
    success = false
  }

  return { success, msg }
}
