import { app } from 'electron'
import { resolve } from 'node:path'

const override = process.env['BRIGHTCODE_USER_DATA_DIR']
export const electronStoreCwd = override ? resolve(override) : undefined
if (electronStoreCwd) app.setPath('userData', electronStoreCwd)
