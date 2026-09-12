"use client";

import { useActionState, useRef, useState, type ReactNode } from "react";
import { createProductFormAction, updateProductFormAction } from "@/app/admin/products/actions";
import {
  productToFormValues,
  EMPTY_PRODUCT_FORM_VALUES,
  type ProductFormState,
} from "@/app/admin/products/product-form";
import type { CategoryDTO, ProductDTO } from "@/lib/db/repositories";

interface ProductFormProps {
  mode: "create" | "edit";
  /** Required for mode="edit" — the product being edited. */
  product?: ProductDTO;
  categories: CategoryDTO[];
}

interface Row {
  id: number;
}

const INITIAL_STATE: ProductFormState = { errors: {}, values: EMPTY_PRODUCT_FORM_VALUES };

/**
 * Shared by `/admin/products/new` and `/admin/products/[id]/edit`
 * (REQUIREMENTS: "Share one form component between new and edit").
 * Uncontrolled fields (`defaultValue`) following `AddressForm`'s convention
 * — only the dynamic images/variants row *counts* are React state, keyed by
 * a per-mount id counter so adding/removing a row never remounts (and so
 * never loses the typed value of) an unrelated row.
 */
export function ProductForm({ mode, product, categories }: ProductFormProps) {
  const action =
    mode === "edit" && product
      ? updateProductFormAction.bind(null, product._id)
      : createProductFormAction;

  const initialState: ProductFormState =
    mode === "edit" && product
      ? { errors: {}, values: productToFormValues(product) }
      : INITIAL_STATE;

  const [state, formAction, isPending] = useActionState(action, initialState);
  const { values, errors } = state;

  const imageIdCounter = useRef(0);
  const [imageRows, setImageRows] = useState<Row[]>(() =>
    (values.images.length > 0 ? values.images : [""]).map(() => ({
      id: imageIdCounter.current++,
    }))
  );

  const variantIdCounter = useRef(0);
  const [variantRows, setVariantRows] = useState<Row[]>(() =>
    values.variants.map(() => ({ id: variantIdCounter.current++ }))
  );

  function addImageRow(): void {
    setImageRows((rows) => [...rows, { id: imageIdCounter.current++ }]);
  }
  function removeImageRow(rowId: number): void {
    setImageRows((rows) => (rows.length > 1 ? rows.filter((r) => r.id !== rowId) : rows));
  }

  function addVariantRow(): void {
    setVariantRows((rows) => [...rows, { id: variantIdCounter.current++ }]);
  }
  function removeVariantRow(rowId: number): void {
    setVariantRows((rows) => rows.filter((r) => r.id !== rowId));
  }

  return (
    <form action={formAction} noValidate className="flex max-w-3xl flex-col gap-6">
      {errors.form && (
        <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {errors.form}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Field label="Slug" name="slug" error={errors.slug} defaultValue={values.slug} required />
          <p className="mt-1 text-xs text-slate-500">
            Lowercase, hyphenated, unique (e.g. <code>acme-widget-pro</code>). Used in the product URL.
          </p>
        </div>
        <Field label="Title" name="title" error={errors.title} defaultValue={values.title} required />
        <Field label="Brand" name="brand" error={errors.brand} defaultValue={values.brand} required />

        <div className="sm:col-span-2">
          <label htmlFor="description" className="block text-sm font-medium text-slate-700">
            Description
          </label>
          <textarea
            id="description"
            name="description"
            rows={4}
            defaultValue={values.description}
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={errors.description ? "description-error" : undefined}
            className={inputClass(Boolean(errors.description))}
          />
          {errors.description && <ErrorText id="description-error">{errors.description}</ErrorText>}
        </div>

        <div>
          <label htmlFor="categorySlug" className="block text-sm font-medium text-slate-700">
            Category
          </label>
          <select
            id="categorySlug"
            name="categorySlug"
            defaultValue={values.categorySlug}
            required
            aria-invalid={errors.categorySlug ? true : undefined}
            aria-describedby={errors.categorySlug ? "categorySlug-error" : undefined}
            className={inputClass(Boolean(errors.categorySlug))}
          >
            <option value="" disabled>
              Select a category…
            </option>
            {categories.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
          {errors.categorySlug && <ErrorText id="categorySlug-error">{errors.categorySlug}</ErrorText>}
        </div>

        <div>
          <label htmlFor="currency" className="block text-sm font-medium text-slate-700">
            Currency
          </label>
          <input
            id="currency"
            name="currency"
            type="text"
            maxLength={3}
            defaultValue={values.currency}
            required
            aria-invalid={errors.currency ? true : undefined}
            aria-describedby={errors.currency ? "currency-error" : undefined}
            className={`${inputClass(Boolean(errors.currency))} uppercase`}
          />
          {errors.currency && <ErrorText id="currency-error">{errors.currency}</ErrorText>}
        </div>

        <div>
          <label htmlFor="price" className="block text-sm font-medium text-slate-700">
            Price ({values.currency || "USD"})
          </label>
          <input
            id="price"
            name="price"
            type="text"
            inputMode="decimal"
            placeholder="19.99"
            defaultValue={values.price}
            required
            aria-invalid={errors.price ? true : undefined}
            aria-describedby={errors.price ? "price-error" : undefined}
            className={inputClass(Boolean(errors.price))}
          />
          {errors.price && <ErrorText id="price-error">{errors.price}</ErrorText>}
          <p className="mt-1 text-xs text-slate-500">
            Stored as an integer number of minor units — just type a normal decimal amount.
          </p>
        </div>

        <Field
          label="Rating (0-5)"
          name="rating"
          type="number"
          step="0.1"
          min={0}
          max={5}
          error={errors.rating}
          defaultValue={values.rating}
          required
        />
        <Field
          label="Review count"
          name="reviewCount"
          type="number"
          step="1"
          min={0}
          error={errors.reviewCount}
          defaultValue={values.reviewCount}
          required
        />
        <Field
          label="Stock"
          name="stock"
          type="number"
          step="1"
          min={0}
          error={errors.stock}
          defaultValue={values.stock}
          required
        />

        <label className="flex items-center gap-2 pt-6 text-sm font-medium text-slate-700">
          <input type="checkbox" name="isActive" value="on" defaultChecked={values.isActive} />
          Active (visible on storefront)
        </label>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-semibold text-slate-800">Images</legend>
        {errors.images && <ErrorText id="images-error">{errors.images}</ErrorText>}
        {imageRows.map((row, index) => {
          const fieldError = errors[`images.${index}`];
          const errorId = `image-${row.id}-error`;
          return (
            <div key={row.id} className="flex items-start gap-2">
              <div className="flex-1">
                <label htmlFor={`image-${row.id}`} className="sr-only">
                  Image path {index + 1}
                </label>
                <input
                  id={`image-${row.id}`}
                  name="images"
                  type="text"
                  placeholder="/products/seed/example-1.webp"
                  defaultValue={values.images[index] ?? ""}
                  aria-invalid={fieldError ? true : undefined}
                  aria-describedby={fieldError ? errorId : undefined}
                  className={inputClass(Boolean(fieldError))}
                />
                {fieldError && <ErrorText id={errorId}>{fieldError}</ErrorText>}
              </div>
              <button
                type="button"
                onClick={() => removeImageRow(row.id)}
                disabled={imageRows.length <= 1}
                className="mt-0.5 rounded border border-slate-300 px-2 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={addImageRow}
          className="self-start rounded border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-100"
        >
          + Add image
        </button>
        <p className="text-xs text-slate-500">
          Relative web paths only, e.g. <code>/products/seed/example-1.webp</code> — no uploads, no
          full URLs, no filesystem paths.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-semibold text-slate-800">Variants</legend>
        {errors.variants && <ErrorText id="variants-error">{errors.variants}</ErrorText>}
        {variantRows.map((row, index) => {
          const variant = values.variants[index];
          const labelError = errors[`variants.${index}.label`];
          const valueError = errors[`variants.${index}.value`];
          return (
            <div
              key={row.id}
              className="grid grid-cols-1 gap-2 rounded-md border border-slate-200 p-3 sm:grid-cols-[1fr_2fr_2fr_auto_auto]"
            >
              <div>
                <label
                  htmlFor={`variant-${row.id}-type`}
                  className="block text-xs font-medium text-slate-600"
                >
                  Type
                </label>
                <select
                  id={`variant-${row.id}-type`}
                  name={`variants.${index}.type`}
                  defaultValue={variant?.type ?? "size"}
                  className={inputClass(false)}
                >
                  <option value="size">Size</option>
                  <option value="colour">Colour</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor={`variant-${row.id}-label`}
                  className="block text-xs font-medium text-slate-600"
                >
                  Label
                </label>
                <input
                  id={`variant-${row.id}-label`}
                  name={`variants.${index}.label`}
                  type="text"
                  placeholder="Medium"
                  defaultValue={variant?.label ?? ""}
                  aria-invalid={labelError ? true : undefined}
                  className={inputClass(Boolean(labelError))}
                />
              </div>
              <div>
                <label
                  htmlFor={`variant-${row.id}-value`}
                  className="block text-xs font-medium text-slate-600"
                >
                  Value
                </label>
                <input
                  id={`variant-${row.id}-value`}
                  name={`variants.${index}.value`}
                  type="text"
                  placeholder="M"
                  defaultValue={variant?.value ?? ""}
                  aria-invalid={valueError ? true : undefined}
                  className={inputClass(Boolean(valueError))}
                />
              </div>
              <label className="flex items-center gap-1.5 self-end pb-1.5 text-xs font-medium text-slate-600">
                <input
                  type="checkbox"
                  name={`variants.${index}.available`}
                  value="on"
                  defaultChecked={variant?.available ?? true}
                />
                Available
              </label>
              <button
                type="button"
                onClick={() => removeVariantRow(row.id)}
                className="self-end rounded border border-slate-300 px-2 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
              >
                Remove
              </button>
              {(labelError || valueError) && (
                <div className="sm:col-span-5">
                  {labelError && <ErrorText id={`variant-${row.id}-label-error`}>{labelError}</ErrorText>}
                  {valueError && <ErrorText id={`variant-${row.id}-value-error`}>{valueError}</ErrorText>}
                </div>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={addVariantRow}
          className="self-start rounded border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-100"
        >
          + Add variant
        </button>
      </fieldset>

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-md bg-slate-900 px-6 py-3 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300 sm:w-auto sm:self-start"
      >
        {isPending ? "Saving…" : mode === "create" ? "Create product" : "Save changes"}
      </button>
    </form>
  );
}

function inputClass(hasError: boolean): string {
  return `mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 ${
    hasError ? "border-red-500" : "border-slate-300"
  }`;
}

function ErrorText({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-red-600">
      {children}
    </p>
  );
}

interface FieldProps {
  label: string;
  name: string;
  type?: string;
  step?: string;
  min?: number;
  max?: number;
  error?: string;
  defaultValue: string;
  required?: boolean;
}

function Field({
  label,
  name,
  type = "text",
  step,
  min,
  max,
  error,
  defaultValue,
  required,
}: FieldProps) {
  const errorId = `${name}-error`;
  return (
    <div>
      <label htmlFor={name} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        step={step}
        min={min}
        max={max}
        defaultValue={defaultValue}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={inputClass(Boolean(error))}
      />
      {error && <ErrorText id={errorId}>{error}</ErrorText>}
    </div>
  );
}
