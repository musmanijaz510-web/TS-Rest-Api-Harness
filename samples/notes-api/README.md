# notes-api (sample existing API)

Stand-in for the "sample existing API" the assignment provides. A small Hono + Zod
API with list/create/get/delete on `/v1/notes`. The brownfield task
(`tasks/notes-patch.task.json`) asks the harness to add `PATCH /v1/notes/:id`.

    npm test           # node --test
    npm run typecheck
