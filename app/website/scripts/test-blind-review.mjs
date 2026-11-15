import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

if (!process.argv[2]) throw new Error('Provide a generated blind-review/index.html path')
const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }) })
const context = await browser.newContext({ acceptDownloads: true })
try {
  const page = await context.newPage()
  await page.goto(pathToFileURL(resolve(process.argv[2])).href)
  const participant = page.locator('#participant')
  const role = page.locator('#role')
  const subject = page.getByLabel('主体符合度', { exact: false })
  assert.equal(await participant.inputValue(), '')
  assert.equal(await subject.inputValue(), '')
  assert.equal(await subject.isDisabled(), true)
  await participant.fill('AUTOMATION_FIXTURE_01')
  await role.selectOption('user')
  assert.equal(await subject.isEnabled(), true)
  await subject.selectOption('3')
  assert.equal(await participant.isDisabled(), true, 'A scored record must retain its original participant')
  assert.equal(await role.isDisabled(), true)

  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('button', { name: '开始另一位参与者', exact: true }).click()
  assert.equal(await participant.inputValue(), 'AUTOMATION_FIXTURE_01')
  assert.equal(await subject.inputValue(), '3')

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出真实评价 JSON', exact: true }).click()
  const download = await downloadPromise
  const output = JSON.parse(await readFile(await download.path(), 'utf8'))
  assert.equal(output.participant, 'AUTOMATION_FIXTURE_01')
  assert.equal(output.ratings.length, 1)
  assert.equal(output.ratings[0].subject, 3)
  assert.equal(output.ratings[0].culture, undefined, 'Unrated dimensions must remain absent')
  assert.equal(JSON.stringify(output).includes('methodId'), false)

  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: '开始另一位参与者', exact: true }).click()
  assert.equal(await participant.inputValue(), '')
  assert.equal(await participant.isEnabled(), true)
  assert.equal(await subject.inputValue(), '')
  assert.equal(await subject.isDisabled(), true)
  await participant.fill('AUTOMATION_FIXTURE_02')
  await role.selectOption('expert')
  await page.getByRole('button', { name: '导出真实评价 JSON', exact: true }).click()
  assert.match(await page.locator('#status').innerText(), /请先填写/)
  await page.reload()
  assert.equal(await participant.inputValue(), 'AUTOMATION_FIXTURE_02')
  assert.equal(await subject.inputValue(), '')
  console.log('Blind-review regression passed. All ratings were isolated automation fixtures; no participant evidence was created.')
} finally {
  await context.close()
  await browser.close()
}
