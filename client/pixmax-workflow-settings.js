/**
 * Browser half of the dsh-pixmax-workflow settings page.
 *
 * Registers one card into the Plugins page's row/bundle "config" slots and talks
 * to the host bridge in `src/settings-host.mjs`:
 *
 *   · 生图模型列表 —— 浏览器渠道 (browser/gpt-image-2) 与任意 OpenAI 兼容端点
 *     (provider/modelid)，可选默认模型、内置模型开关；
 *   · API Key —— 每个端点一个，写入 DSH 凭据中心（环境变量优先时会被拒绝），
 *     页面只显示是否已配置与来源，永远不显示值。
 *
 * No build step: this file is loaded as-is by the client module loader.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pixmax-workflow',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PREFIX = '/api/dsh-pixmax-workflow'

    async function call(path, init) {
      const response = await fetch(PREFIX + path, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init && init.headers) },
      })
      let body = null
      try {
        body = await response.json()
      } catch {}
      if (!response.ok || !body || body.ok === false) {
        throw new Error((body && body.error) || `HTTP ${response.status}`)
      }
      return body
    }

    const state = () => call('/state', { method: 'GET', headers: {} })
    const save = (payload) => call('/save', { method: 'POST', body: JSON.stringify(payload) })
    const keyAction = (payload) => call('/key', { method: 'POST', body: JSON.stringify(payload) })

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13, lineHeight: 1.5 },
      head: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
      title: { fontSize: 14, fontWeight: 600 },
      hint: { opacity: 0.65 },
      box: { border: '1px solid var(--dsh-border, rgba(127,127,127,.28))', borderRadius: 10, padding: '10px 12px' },
      boxHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      badge: { fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid currentColor', opacity: 0.8 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginTop: 8 },
      label: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '4px 6px',
        fontSize: 12,
        color: 'inherit',
        background: 'transparent',
        border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
        borderRadius: 6,
      },
      button: {
        padding: '3px 10px',
        fontSize: 12,
        cursor: 'pointer',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid var(--dsh-border, rgba(127,127,127,.45))',
        borderRadius: 6,
      },
      primary: { fontWeight: 600 },
      error: { color: 'var(--dsh-danger, #d9534f)' },
      ok: { color: 'var(--dsh-success, #2e7d32)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 11, opacity: 0.8 },
    }

    const EMPTY_MODEL = {
      id: '',
      label: '',
      kind: 'openai',
      provider: '',
      model: '',
      baseUrl: '',
      apiStyle: 'json',
      envKey: '',
      note: '',
    }

    function textField(name, label, value, onChange, placeholder, extra) {
      return h(
        'label',
        { style: styles.label },
        label,
        h('input', {
          style: styles.input,
          value: value == null ? '' : String(value),
          placeholder: placeholder || '',
          onChange: (event) => onChange(name, event.target.value),
          ...extra,
        }),
      )
    }

    function keyBadge(key) {
      if (!key) return null
      if (key.source === 'browser') return h('span', { style: styles.badge }, '无需 key')
      if (key.configured) return h('span', { style: { ...styles.badge, ...styles.ok } }, key.source === 'env' ? 'key: 环境变量' : 'key: 凭据中心')
      return h('span', { style: { ...styles.badge, ...styles.error } }, 'key: 未配置')
    }

    const cliState = () => call('/cli', { method: 'GET', headers: {} })
    const cliSave = (payload) => call('/cli/set', { method: 'POST', body: JSON.stringify(payload) })

    /** Pixmax CLI home / environment — editable from the plugin config page. */
    function CliConfigCard() {
      const [info, setInfo] = React.useState(null)
      const [home, setHome] = React.useState('')
      const [environment, setEnvironment] = React.useState('')
      const [error, setError] = React.useState('')
      const [message, setMessage] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const reload = React.useCallback(async () => {
        try {
          const next = await cliState()
          setInfo(next)
          setHome(next.home || '')
          setEnvironment(next.environment || '')
        } catch (failure) {
          setError(String(failure.message || failure))
        }
      }, [])

      React.useEffect(() => {
        reload()
      }, [reload])

      const persist = async (nextHome, nextEnv) => {
        setBusy(true)
        setError('')
        setMessage('')
        try {
          const next = await cliSave({ home: nextHome, environment: nextEnv })
          setInfo(next)
          setHome(next.home || '')
          setEnvironment(next.environment || '')
          setMessage('已保存；下次调用 pixmax 工具时生效。')
        } catch (failure) {
          setError(String(failure.message || failure))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { style: { ...styles.root, marginTop: 12 } },
        h(
          'div',
          { style: styles.head },
          h('span', { style: styles.title }, 'Pixmax CLI 路径'),
          h('span', { style: styles.hint }, '留空用默认 ~/.pixmax-cli；路径错误只在调用工具时报错，不影响插件加载。'),
        ),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.mono }, info ? info.effectiveHome : '读取中…'),
          info ? h('span', { style: { ...styles.badge, ...(info.exists ? styles.ok : styles.error) } }, info.exists ? '目录存在' : '目录不存在') : null,
          info ? h('span', { style: styles.badge }, info.source === 'settings' ? '来自设置页' : '默认值') : null,
        ),
        h(
          'div',
          { style: styles.grid },
          h(
            'label',
            { style: styles.label },
            'CLI 主目录（pixmaxHome）',
            h('input', {
              style: styles.input,
              value: home,
              placeholder: info ? info.defaultHome : '',
              onChange: (event) => setHome(event.target.value),
            }),
          ),
          h(
            'label',
            { style: styles.label },
            '环境（PIXMAX_ENV）',
            h(
              'select',
              { style: styles.input, value: environment, onChange: (event) => setEnvironment(event.target.value) },
              h('option', { value: '' }, '默认（cn）'),
              h('option', { value: 'cn' }, 'cn'),
              h('option', { value: 'global' }, 'global'),
            ),
          ),
        ),
        h(
          'div',
          { style: styles.row },
          h(
            'button',
            { style: { ...styles.button, ...styles.primary }, type: 'button', disabled: busy, onClick: () => persist(home, environment) },
            busy ? '保存中…' : '保存',
          ),
          h(
            'button',
            { style: styles.button, type: 'button', disabled: busy, onClick: () => { setHome(''); setEnvironment(''); persist('', '') } },
            '恢复默认',
          ),
          h('span', { style: styles.hint }, '也可以在本行 config 里直接写 pixmaxHome。'),
        ),
        error ? h('div', { style: styles.error }, error) : null,
        message ? h('div', { style: styles.ok }, message) : null,
      )
    }

    function cliSummaryText() {
      return 'Pixmax CLI 主目录与运行环境；留空用默认 ~/.pixmax-cli。'
    }

    function PixmaxWorkflowCard() {
      const [view, setView] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [error, setError] = React.useState('')
      const [message, setMessage] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [keyInputs, setKeyInputs] = React.useState({})
      const [newModel, setNewModel] = React.useState(null)

      const adopt = React.useCallback((next) => {
        setView(next)
        setDraft({
          defaultModel: next.defaultModel,
          disabledBuiltins: Array.isArray(next.disabledBuiltins) ? next.disabledBuiltins.slice() : [],
          models: (next.models || []).map((model) => ({ ...model })),
        })
      }, [])

      const reload = React.useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          adopt(await state())
        } catch (failure) {
          setError(String(failure.message || failure))
        } finally {
          setBusy(false)
        }
      }, [adopt])

      React.useEffect(() => {
        reload()
      }, [reload])

      const patchModel = (id, name, value) =>
        setDraft((current) => ({
          ...current,
          models: current.models.map((model) => (model.id === id ? { ...model, [name]: value } : model)),
        }))

      const toggleBuiltin = (id) =>
        setDraft((current) => {
          const off = new Set(current.disabledBuiltins)
          if (off.has(id)) off.delete(id)
          else off.add(id)
          return { ...current, disabledBuiltins: [...off] }
        })

      const removeModel = (id) =>
        setDraft((current) => {
          const models = current.models.filter((model) => model.id !== id)
          const ids = [...(current.disabledBuiltins || [])]
          const nextDefault = current.defaultModel === id ? (view?.builtins?.find((builtin) => !ids.includes(builtin.id))?.id || models[0]?.id || 'browser/gpt-image-2') : current.defaultModel
          return { ...current, models, defaultModel: nextDefault }
        })

      const commit = async () => {
        setBusy(true)
        setError('')
        setMessage('')
        try {
          const next = await save({
            defaultModel: draft.defaultModel,
            disabledBuiltins: draft.disabledBuiltins,
            models: draft.models.map((model) => ({
              id: model.id,
              label: model.label,
              kind: model.kind,
              provider: model.provider || String(model.id).split('/')[0],
              model: model.model || String(model.id).split('/')[1],
              baseUrl: model.baseUrl,
              apiStyle: model.apiStyle,
              envKey: model.envKey,
            })),
          })
          adopt(next)
          setMessage('已保存到 ' + next.path)
        } catch (failure) {
          setError(String(failure.message || failure))
        } finally {
          setBusy(false)
        }
      }

      const pushKey = async (id, action) => {
        const value = keyInputs[id] || ''
        if (action === 'set' && !value.trim()) {
          setError('请先填 API key')
          return
        }
        setBusy(true)
        setError('')
        setMessage('')
        try {
          const next = await keyAction({ action, modelId: id, value })
          adopt(next)
          setKeyInputs((current) => ({ ...current, [id]: '' }))
          setMessage(action === 'set' ? '已写入 DSH 凭据中心' : action === 'clear' ? '已从凭据中心删除' : '')
        } catch (failure) {
          setError(String(failure.message || failure))
        } finally {
          setBusy(false)
        }
      }

      if (error && !view) return h('div', { style: { ...styles.root, ...styles.error } }, '设置页桥接不可用：' + error)
      if (!view || !draft) return h('div', { style: styles.root }, busy ? '正在读取生图模型…' : '生图模型')

      const enabledBuiltins = (view.builtins || []).filter((builtin) => !draft.disabledBuiltins.includes(builtin.id))
      const allIds = [...enabledBuiltins.map((builtin) => builtin.id), ...draft.models.map((model) => model.id)]

      function builtinRow(builtin) {
        const off = draft.disabledBuiltins.includes(builtin.id)
        return h(
          'div',
          { key: builtin.id, style: { ...styles.box, opacity: off ? 0.55 : 1, marginTop: 8 } },
          h(
            'div',
            { style: styles.boxHead },
            h('input', {
              type: 'radio',
              name: 'pixmax-workflow-default-model',
              checked: draft.defaultModel === builtin.id,
              disabled: off,
              onChange: () => setDraft({ ...draft, defaultModel: builtin.id }),
            }),
            h('strong', null, builtin.label),
            h('span', { style: styles.mono }, builtin.id),
            h('span', { style: styles.badge }, '内置'),
            keyBadge(builtin.key),
            h('span', { style: { flex: 1 } }),
            h(
              'button',
              { style: styles.button, type: 'button', disabled: busy, onClick: () => toggleBuiltin(builtin.id) },
              off ? '启用' : '停用',
            ),
          ),
          builtin.note ? h('div', { style: styles.hint }, builtin.note) : null,
          builtin.kind === 'openai'
            ? h(
                'div',
                { style: { ...styles.row, marginTop: 6 } },
                h('input', {
                  style: { ...styles.input, flex: 1, minWidth: 180 },
                  type: 'password',
                  autoComplete: 'off',
                  placeholder: builtin.envKey ? '粘贴 key（环境变量 ' + builtin.envKey + ' 已设置时不可写入）' : '粘贴 key',
                  value: keyInputs[builtin.id] || '',
                  onChange: (event) => setKeyInputs({ ...keyInputs, [builtin.id]: event.target.value }),
                }),
                h('button', { style: { ...styles.button, ...styles.primary }, type: 'button', disabled: busy, onClick: () => pushKey(builtin.id, 'set') }, '保存 key'),
                h('button', { style: styles.button, type: 'button', disabled: busy, onClick: () => pushKey(builtin.id, 'clear') }, '删除 key'),
              )
            : null,
        )
      }

      function userModelRow(model, index) {
        return h(
          'div',
          { key: model.id || 'new-' + index, style: { ...styles.box, marginTop: 8 } },
          h(
            'div',
            { style: styles.boxHead },
            h('input', {
              type: 'radio',
              name: 'pixmax-workflow-default-model',
              checked: draft.defaultModel === model.id,
              onChange: () => setDraft({ ...draft, defaultModel: model.id }),
            }),
            h('strong', null, model.label || model.id || '新模型'),
            h('span', { style: styles.mono }, model.id || '(缺 id)'),
            h('span', { style: styles.badge }, '自定义'),
            keyBadge(model.key),
            h('span', { style: { flex: 1 } }),
            h('button', { style: styles.button, type: 'button', disabled: busy, onClick: () => removeModel(model.id) }, '删除'),
          ),
          h(
            'div',
            { style: styles.grid },
            textField('label', '显示名', model.label, (name, value) => patchModel(model.id, name, value), '例如 我的 GPT-Image 端点'),
            textField('id', '模型 id（provider/model）', model.id, (name, value) => patchModel(model.id, name, value), '例如 openai/gpt-image-1'),
            textField('baseUrl', 'Base URL', model.baseUrl, (name, value) => patchModel(model.id, name, value), 'https://api.example.com/v1'),
            textField('model', '端点模型名', model.model, (name, value) => patchModel(model.id, name, value), '例如 gpt-image-1'),
            textField('envKey', '环境变量名（可选）', model.envKey, (name, value) => patchModel(model.id, name, value), '例如 MY_OPENAI_API_KEY'),
          ),
          h(
            'label',
            { style: { ...styles.label, marginTop: 6 } },
            '请求体格式',
            h(
              'select',
              {
                style: styles.input,
                value: model.apiStyle || 'json',
                onChange: (event) => patchModel(model.id, 'apiStyle', event.target.value),
              },
              h('option', { value: 'json' }, 'JSON + data URL（SenseNova 风格）'),
              h('option', { value: 'multipart' }, 'multipart/form-data（OpenAI 标准）'),
            ),
          ),
          h(
            'div',
            { style: { ...styles.row, marginTop: 6 } },
            h('input', {
              style: { ...styles.input, flex: 1, minWidth: 180 },
              type: 'password',
              autoComplete: 'off',
              placeholder: '粘贴 API key',
              value: keyInputs[model.id] || '',
              onChange: (event) => setKeyInputs({ ...keyInputs, [model.id]: event.target.value }),
            }),
            h('button', { style: { ...styles.button, ...styles.primary }, type: 'button', disabled: busy, onClick: () => pushKey(model.id, 'set') }, '保存 key'),
            h('button', { style: styles.button, type: 'button', disabled: busy, onClick: () => pushKey(model.id, 'clear') }, '删除 key'),
          ),
        )
      }

      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.head },
          h('span', { style: styles.title }, '生图模型'),
          h('span', { style: styles.hint }, 'image_generation 的 model 参数取这里的 id；不传就用默认模型。'),
        ),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.hint }, '默认模型'),
          h(
            'select',
            {
              style: { ...styles.input, width: 'auto', minWidth: 260 },
              value: draft.defaultModel || '',
              onChange: (event) => setDraft({ ...draft, defaultModel: event.target.value }),
            },
            allIds.map((id) => h('option', { key: id, value: id }, id)),
          ),
          h('span', { style: { flex: 1 } }),
          h('button', { style: styles.button, type: 'button', disabled: busy, onClick: reload }, '重新读取'),
          h(
            'button',
            { style: { ...styles.button, ...styles.primary }, type: 'button', disabled: busy, onClick: commit },
            busy ? '保存中…' : '保存',
          ),
        ),
        (view.builtins || []).map(builtinRow),
        h('div', { style: { ...styles.title, marginTop: 6 } }, '自定义模型'),
        draft.models.length === 0 ? h('div', { style: styles.hint }, '还没有自定义模型。点下面的按钮添加一个 OpenAI 兼容端点。') : null,
        draft.models.map(userModelRow),
        newModel
          ? h(
              'div',
              { style: { ...styles.box, marginTop: 8 } },
              h('div', { style: styles.boxHead }, h('strong', null, '新模型'), h('span', { style: { flex: 1 } }), h('button', { style: styles.button, type: 'button', onClick: () => setNewModel(null) }, '取消')),
              h(
                'div',
                { style: styles.grid },
                textField('label', '显示名', newModel.label, (name, value) => setNewModel({ ...newModel, [name]: value }), '例如 我的 GPT-Image 端点'),
                textField('id', '模型 id（provider/model）', newModel.id, (name, value) => setNewModel({ ...newModel, [name]: value }), '例如 openai/gpt-image-1'),
                textField('baseUrl', 'Base URL', newModel.baseUrl, (name, value) => setNewModel({ ...newModel, [name]: value }), 'https://api.example.com/v1'),
                textField('model', '端点模型名', newModel.model, (name, value) => setNewModel({ ...newModel, [name]: value }), '例如 gpt-image-1'),
                textField('envKey', '环境变量名（可选）', newModel.envKey, (name, value) => setNewModel({ ...newModel, [name]: value }), '例如 MY_OPENAI_API_KEY'),
              ),
              h(
                'div',
                { style: { ...styles.row, marginTop: 8 } },
                h(
                  'button',
                  {
                    style: { ...styles.button, ...styles.primary },
                    type: 'button',
                    onClick: () => {
                      const provider = String(newModel.provider || newModel.id.split('/')[0] || '').trim()
                      const modelCode = String(newModel.model || newModel.id.split('/')[1] || '').trim()
                      const id = newModel.id.includes('/') ? newModel.id.trim() : provider && modelCode ? provider + '/' + modelCode : ''
                      if (!id) {
                        setError('模型 id 必须是 provider/model')
                        return
                      }
                      if (allIds.includes(id)) {
                        setError('模型 id 已存在: ' + id)
                        return
                      }
                      setError('')
                      setDraft({
                        ...draft,
                        models: [
                          ...draft.models,
                          {
                            id,
                            label: newModel.label || id,
                            kind: 'openai',
                            provider,
                            model: modelCode,
                            baseUrl: newModel.baseUrl,
                            apiStyle: newModel.apiStyle || 'json',
                            envKey: newModel.envKey,
                            key: { configured: false, source: 'none' },
                          },
                        ],
                      })
                      setNewModel(null)
                    },
                  },
                  '加入列表',
                ),
                h('span', { style: styles.hint }, '加入后记得点上面的「保存」。'),
              ),
            )
          : h(
              'div',
              { style: { ...styles.row, marginTop: 8 } },
              h(
                'button',
                { style: styles.button, type: 'button', disabled: busy, onClick: () => setNewModel({ ...EMPTY_MODEL }) },
                '＋ 添加 OpenAI 兼容端点',
              ),
            ),
        error ? h('div', { style: styles.error }, error) : null,
        message ? h('div', { style: styles.ok }, message) : null,
        h('div', { style: styles.hint }, 'API key 存放在 DSH 凭据中心；同名环境变量优先（存在时设置页会拒绝写入）。'),
        h(CliConfigCard, null),
      )
    }

    function summaryText() {
      return '生图模型：浏览器渠道 + OpenAI 兼容端点；API key 在设置页管理。'
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            { name: 'plugins.row.config', key: 'dsh-pixmax-workflow#image-tools' },
            (slotProps) => (slotProps && slotProps.view === 'summary' ? summaryText() : h(PixmaxWorkflowCard, null)),
          ),
        )
        // Row config keys are `<package name>#<row id from cordis.patch.yml>`.
        // The pixmax-tools row gets its own config page with just the CLI path.
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            { name: 'plugins.row.config', key: 'dsh-pixmax-workflow#pixmax-tools' },
            (slotProps) => (slotProps && slotProps.view === 'summary' ? cliSummaryText() : h(CliConfigCard, null)),
          ),
        )
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: 'dsh-pixmax-workflow' },
            (slotProps) => (slotProps && slotProps.view === 'summary' ? summaryText() : h(PixmaxWorkflowCard, null)),
          ),
        )
      },
    }
  },
})
