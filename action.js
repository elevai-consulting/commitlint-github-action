const { existsSync } = require('fs')
const { resolve } = require('path')
const core = require('@actions/core')
const github = require('@actions/github')
const lint = require('@commitlint/lint')
const { format } = require('@commitlint/format')
const load = require('@commitlint/load')
const gitRawCommits = require('git-raw-commits')

const pullRequestEvent = 'pull_request'

const { GITHUB_TOKEN, GITHUB_EVENT_NAME, GITHUB_SHA } = process.env

const configPath = resolve(
  process.env.GITHUB_WORKSPACE,
  core.getInput('configFile'),
)

const { context: eventContext } = github

const pushEventHasOnlyOneCommit = from => {
  const gitEmptySha = '0000000000000000000000000000000000000000'

  return from === gitEmptySha
}

const getRangeForPushEvent = () => {
  let from = eventContext.payload.before
  const to = GITHUB_SHA

  if (eventContext.payload.forced) {
    // When a commit is forced, "before" field from the push event data may point to a commit that doesn't exist
    console.warn(
      'Commit was forced, checking only the latest commit from push instead of a range of commit messages',
    )
    from = null
  }

  if (pushEventHasOnlyOneCommit(from)) {
    from = null
  }

  return [from, to]
}

const getRangeForEvent = async () => {
  if (GITHUB_EVENT_NAME !== pullRequestEvent) return getRangeForPushEvent()

  const octokit = new github.GitHub(GITHUB_TOKEN)
  const { owner, repo, number } = eventContext.issue
  const { data: commits } = await octokit.pulls.listCommits({
    owner,
    repo,
    pull_number: number,
  })
  const commitShas = commits.map(commit => commit.sha)
  const [from] = commitShas
  const to = commitShas[commitShas.length - 1]
  // Git revision range doesn't include the "from" field in "git log", so for "from" we use the parent commit of PR's first commit
  const fromParent = `${from}^1`

  return [fromParent, to]
}

function getHistoryCommits(from, to) {
  const options = {
    from,
    to,
  }

  if (core.getInput('firstParent') === 'true') {
    options.firstParent = true
  }

  if (!from) {
    options.maxCount = 1
  }

  return new Promise((resolve, reject) => {
    const data = []

    gitRawCommits(options)
      .on('data', chunk => data.push(chunk.toString('utf-8')))
      .on('error', reject)
      .on('end', () => {
        resolve(data)
      })
  })
}

function getOptsFromConfig(config) {
  return {
    parserOpts:
      config.parserPreset != null && config.parserPreset.parserOpts != null
        ? config.parserPreset.parserOpts
        : {},
    plugins: config.plugins != null ? config.plugins : {},
    ignores: config.ignores != null ? config.ignores : [],
    defaultIgnores:
      config.defaultIgnores != null ? config.defaultIgnores : true,
  }
}

const formatErrors = results =>
  format(
    { results },
    {
      color: true,
      helpUrl: core.getInput('helpURL'),
    },
  )

const hasOnlyWarnings = results => {
  const resultsWithOnlyWarnings = results.filter(
    result => result.valid && result.warnings.length,
  )

  return (
    resultsWithOnlyWarnings.length &&
    resultsWithOnlyWarnings.length === results.length
  )
}

const setFailed = formattedResults => {
  core.setFailed(`You have commit messages with errors\n\n${formattedResults}`)
}

const handleOnlyWarnings = formattedResults => {
  if (core.getInput('failOnWarnings') === 'true') {
    setFailed(formattedResults)
  } else {
    console.log(`You have commit messages with warnings\n\n${formattedResults}`)
  }
}

const showLintResults = async ([from, to]) => {
  const failOnWarnings = core.getInput('failOnWarnings')
  const commits = await getHistoryCommits(from, to)
  const config = existsSync(configPath)
    ? await load({}, { file: configPath })
    : {}
  const opts = getOptsFromConfig(config)
  const results = await Promise.all(
    commits.map(commit => lint(commit, config.rules, opts)),
  )
  const formattedResults = formatErrors(results)

  if (hasOnlyWarnings(results)) {
    handleOnlyWarnings(formattedResults)
  } else if (formattedResults) {
    setFailed(formattedResults)
  } else {
    console.log('Lint free! 🎉')
  }
}

const exitWithMessage = message => error => {
  core.setFailed(`${message}\n${error.message}\n${error.stack}`)
}

const commitLinterAction = () =>
  getRangeForEvent()
    .catch(
      exitWithMessage("error trying to get list of pull request's commits"),
    )
    .then(showLintResults)
    .catch(exitWithMessage('error running commitlint'))

module.exports = commitLinterAction
