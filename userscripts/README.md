# userscripts/

Сюда подключаются юзерскрипты. Конвенция: **каждый юзерскрипт — отдельный
репозиторий**, в этот проект он подключается **git-сабмодулем** (без копий;
обновления видны через `git submodule status`).

## Шпаргалка по сабмодулям

**Подключить новый скрипт** (из корня этого репо, на хосте):

```bash
git submodule add /полный/путь/к/репо-скрипта userscripts/<имя>
git commit -m "chore(userscripts): add <имя> submodule"
```

**Проверить, есть ли обновления:**

```bash
git submodule status
# «+» в начале строки = в репо скрипта есть новые коммиты
# «-» = сабмодуль не инициализирован (см. последний пункт)
```

**Подтянуть свежее во все сабмодули и зафиксировать:**

```bash
git submodule update --remote
git add userscripts/ && git commit -m "chore(userscripts): bump submodules"
```

**Работа над скриптом:** идёшь в `userscripts/<имя>` — это обычный репо:
правишь, коммитишь, пушишь ТАМ. Потом в этом репо фиксируешь новый указатель:

```bash
git add userscripts/<имя> && git commit -m "chore(userscripts): bump <имя>"
```

**После свежего клона этого репо** (сабмодули пустые):

```bash
git submodule update --init
```
