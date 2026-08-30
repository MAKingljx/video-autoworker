import { z } from 'zod'

export const n8nMaterialIdentitySchema = z.string().trim().regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/,
  'materialId 必须是受控素材稳定标识',
)
