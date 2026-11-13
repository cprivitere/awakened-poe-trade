import { clipboard, Clipboard } from 'electron'
import type { Logger } from '../RemoteLogger'

const POLL_DELAY = 48
const POLL_LIMIT = 500

// PoE must read clipboard within this timeframe,
// after that we restore clipboard.
// If game lagged for some reason, it will read
// wrong content (= restored clipboard, potentially containing password).
const RESTORE_AFTER = 120

export class HostClipboard {
  private pollPromise?: Promise<string>
  private elapsed = 0
  private shouldRestore = false

  private isRestored = true

  get isPolling () { return this.pollPromise != null }

  constructor (
    private logger: Logger
  ) {}

  updateOptions (restoreClipboard: boolean) {
    this.shouldRestore = restoreClipboard
  }

  async readItemText (): Promise<string> {
    this.elapsed = 0
    if (this.pollPromise) {
      return await this.pollPromise
    }

    let textBefore = await clipboard.readText()
    if (isPoeItem(textBefore)) {
      textBefore = ''
      if (process.platform !== 'linux') {
        await clipboard.writeText('')
      } else {
        // workaround KDE's "Prevent empty clipboard" feature
        // see https://github.com/SnosMe/awakened-poe-trade/issues/1790#issuecomment-4062830614
        await clipboard.writeText(`__APT_FORCE_EMPTY_${Date.now()}`)
      }
    } else if (process.platform === 'linux') {
      // workaround bug in Proton 10+ https://github.com/SnosMe/awakened-poe-trade/issues/1846
      await clipboard.writeText(`__APT_FORCE_EMPTY_${Date.now()}`)
    }

    const { promise, resolve, reject } = Promise.withResolvers<string>()
    this.pollPromise = promise
    const poll = async (): Promise<void> => {
      let textAfter: string
      try {
        textAfter = await clipboard.readText()
      } catch (err) {
        this.pollPromise = undefined
        reject(err)
        return
      }

      if (isPoeItem(textAfter)) {
        try {
          if (this.shouldRestore) {
            await clipboard.writeText(textBefore)
          }
        } catch (err) {
          this.pollPromise = undefined
          reject(err)
          return
        }
        this.pollPromise = undefined
        resolve(textAfter)
      } else {
        this.elapsed += POLL_DELAY
        if (this.elapsed < POLL_LIMIT) {
          setTimeout(poll, POLL_DELAY)
        } else {
          try {
            if (this.shouldRestore) {
              await clipboard.writeText(textBefore)
            }
          } catch (err) {
            this.pollPromise = undefined
            reject(err)
            return
          }
          this.pollPromise = undefined

          if (!isPoeItem(textAfter)) {
            this.logger.write('warn [ClipboardPoller] No item text found.')
          }
          reject(new Error('Reading clipboard timed out'))
        }
      }
    }
    setTimeout(poll, POLL_DELAY)

    return promise
  }

  // when `shouldRestore` is false, this function continues
  // to work as a throttler for callback
  async restoreShortly (cb: (clipboard: Clipboard) => void | Promise<void>): Promise<void> {
    // Not only do we not overwrite the clipboard, but we don't exec callback.
    // This throttling helps against disconnects from "Too many actions".
    if (!this.isRestored) {
      return
    }

    this.isRestored = false
    const saved = await clipboard.readText()
    await cb(clipboard)
    setTimeout(async () => {
      try {
        if (this.shouldRestore) {
          await clipboard.writeText(saved)
        }
      } catch (err) {
        this.logger.write(`warn [Clipboard] Restore failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        this.isRestored = true
      }
    }, RESTORE_AFTER)
  }
}

function isPoeItem (text: string) {
  return LANGUAGE_DETECTOR.find(({ firstLine }) => text.startsWith(firstLine))
}

const LANGUAGE_DETECTOR = [{
  lang: 'en',
  firstLine: 'Item Class: '
}, {
  lang: 'ru',
  firstLine: 'Класс предмета: '
}, {
  lang: 'fr',
  firstLine: 'Classe d\'objet: '
}, {
  lang: 'de',
  firstLine: 'Gegenstandsklasse: '
}, {
  lang: 'pt',
  firstLine: 'Classe do Item: '
}, {
  lang: 'es',
  firstLine: 'Clase de objeto: '
}, {
  lang: 'th',
  firstLine: 'ชนิดไอเทม: '
}, {
  lang: 'ko',
  firstLine: '아이템 종류: '
}, {
  lang: 'cmn-Hant',
  firstLine: '物品種類: '
}, {
  lang: 'cmn-Hans',
  firstLine: '物品类别: '
}]
